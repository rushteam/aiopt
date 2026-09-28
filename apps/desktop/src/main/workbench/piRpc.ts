// A client for one pi process in RPC mode (`pi --mode rpc`).
//
// Commands go to stdin as JSONL; stdout carries two kinds of record: `response` (matched to a
// command by `id`) and everything else, an event (docs/rpc.md). The child is injected as a
// minimal stream shape, so the client unit-tests against a fake without spawning pi.
//
// Extension UI dialogs (select / confirm / input / editor) block pi until answered. The
// orchestrator loads no extension that asks, but if one ever does, the dialog is cancelled at
// once rather than left to hang the chat.

import { createJsonlDecoder, encodeJsonl } from './jsonl';

/** The part of a ChildProcess this client uses. */
export interface PiChild {
  stdin: { write(chunk: string): unknown; end(): unknown } | null;
  stdout: { setEncoding(enc: 'utf8'): unknown; on(ev: 'data', cb: (chunk: string) => void): unknown } | null;
  on(ev: 'exit', cb: (code: number | null, signal: string | null) => void): unknown;
  on(ev: 'error', cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

/** A command pi rejected (`success: false`), or the process went away first. */
export class PiRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiRpcError';
  }
}

/** The parts of `get_state` the workbench reads. Absent fields are null. */
export interface PiSessionState {
  sessionFile: string | null;
  sessionId: string | null;
  messageCount: number;
}

export interface PiRpcClient {
  /** Send a user message. While pi is streaming it is queued as a follow-up. */
  prompt(message: string, streaming: boolean): Promise<void>;
  /**
   * Run an extension command (`/name args`). pi runs it at once, even mid-stream, so it takes
   * no streaming behavior; the `steer` / `follow_up` commands refuse extension commands.
   */
  command(text: string): Promise<void>;
  abort(): Promise<void>;
  newSession(): Promise<void>;
  /** Load a session file pi keeps. pi does not check that the file exists; the caller must. */
  switchSession(sessionPath: string): Promise<void>;
  setSessionName(name: string): Promise<void>;
  getState(): Promise<PiSessionState>;
  /** The current session's messages, raw (docs/rpc.md `get_messages`). */
  getMessages(): Promise<unknown[]>;
  /** A no-op round trip (`get_state`), to learn that pi is up and answering. */
  ping(): Promise<void>;
  /** Close stdin and kill the process. Pending commands reject. */
  dispose(): void;
  readonly exited: boolean;
}

export interface PiRpcOptions {
  onEvent: (event: Record<string, unknown>) => void;
  onExit: (code: number | null) => void;
  /** Per-command response timeout. */
  timeoutMs?: number;
}

const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

export function createPiRpcClient(child: PiChild, opts: PiRpcOptions): PiRpcClient {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pending = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let seq = 0;
  let exited = false;

  function settle(id: string, err: Error | null, data?: unknown): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (err) entry.reject(err);
    else entry.resolve(data);
  }

  function write(record: Record<string, unknown>): boolean {
    if (exited || !child.stdin) return false;
    try {
      child.stdin.write(encodeJsonl(record));
      return true;
    } catch {
      return false;
    }
  }

  const decoder = createJsonlDecoder((record) => {
    if (record.type === 'response') {
      if (typeof record.id !== 'string') return;
      const error = record.success === false ? new PiRpcError(typeof record.error === 'string' ? record.error : 'rejected') : null;
      settle(record.id, error, record.data);
      return;
    }
    if (record.type === 'extension_ui_request') {
      if (typeof record.id === 'string' && typeof record.method === 'string' && DIALOG_METHODS.has(record.method)) {
        write({ type: 'extension_ui_response', id: record.id, cancelled: true });
      }
      return;
    }
    opts.onEvent(record);
  });

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => decoder.push(chunk));

  function onGone(code: number | null): void {
    if (exited) return;
    exited = true;
    decoder.end();
    for (const id of [...pending.keys()]) settle(id, new PiRpcError('pi exited'));
    opts.onExit(code);
  }
  child.on('exit', (code) => onGone(code));
  child.on('error', () => onGone(null));

  function request(command: Record<string, unknown>): Promise<unknown> {
    seq += 1;
    const id = `r${seq}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => settle(id, new PiRpcError('pi did not respond')), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      if (!write({ ...command, id })) settle(id, new PiRpcError('pi is not running'));
    });
  }

  function send(command: Record<string, unknown>): Promise<void> {
    return request(command).then(() => undefined);
  }

  return {
    prompt(message, streaming) {
      return send(streaming ? { type: 'prompt', message, streamingBehavior: 'followUp' } : { type: 'prompt', message });
    },
    command: (text) => send({ type: 'prompt', message: text }),
    abort: () => send({ type: 'abort' }),
    newSession: () => send({ type: 'new_session' }),
    switchSession: (sessionPath) => send({ type: 'switch_session', sessionPath }),
    setSessionName: (name) => send({ type: 'set_session_name', name }),
    async getState() {
      const data = asRecord(await request({ type: 'get_state' }));
      return {
        sessionFile: typeof data.sessionFile === 'string' ? data.sessionFile : null,
        sessionId: typeof data.sessionId === 'string' ? data.sessionId : null,
        messageCount: typeof data.messageCount === 'number' && Number.isFinite(data.messageCount) ? data.messageCount : 0,
      };
    },
    async getMessages() {
      const data = asRecord(await request({ type: 'get_messages' }));
      return Array.isArray(data.messages) ? data.messages : [];
    },
    ping: () => send({ type: 'get_state' }),
    dispose() {
      try {
        child.stdin?.end();
      } catch {
        // Already closed.
      }
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      onGone(null);
    },
    get exited() {
      return exited;
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
