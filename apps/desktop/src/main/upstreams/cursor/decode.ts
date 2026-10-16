// Cursor `AgentService/Run` server stream → answer events.
//
// Follows the server's AgentServerMessages until the turn ends or the model has made its
// tool calls, answering what the server asks of the client on the way (blobs it wants, the
// MCP tool list, the request context) and refusing every one of Cursor's OWN tools (shell,
// file reads, edits): only the caller's tools are ever offered, and they go back to the
// caller as OpenAI tool calls rather than being run here. Ported from
// @magpie-community/opencode-cursor-auth (index.mjs `decode` / `exec` / `failure`).
//
// Pure: transport-free (frames in, `send` out). Unit-tested in upstreams/__tests__/cursorDecode.test.ts.

import { randomBytes } from 'node:crypto';
import { env, toolDef, TOOL_NS, type CursorTool } from './conversation';
import type { UpstreamEvent, UpstreamFailure, UpstreamUsage } from '../types';
import { field, fields, pb, pbAny, pbNum, pbStr, type ConnectFrame } from './protobuf';

const EMPTY = Buffer.alloc(0);

// The answer events are the driver-neutral ones (../types); these names stay for the port.
export type CursorUsage = UpstreamUsage;
export type CursorFailure = UpstreamFailure;
export type CursorEvent = UpstreamEvent;

const regional = (msg: string): boolean => msg.toLowerCase().includes('region');

/** Cursor's Connect error (unary body or a stream's end frame) as a status + message. */
export function failure(status: number, text: string | Buffer): CursorFailure {
  const raw = typeof text === 'string' ? text : text.toString('utf8');
  let e: unknown;
  try {
    e = JSON.parse(raw);
  } catch {
    return statusOf(status, '', raw.trim());
  }
  const obj = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
  const f = (obj.error && typeof obj.error === 'object' ? obj.error : obj) as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  let msg = typeof f.message === 'string' ? f.message : '';
  for (const d of Array.isArray(f.details) ? f.details : []) {
    const dd = (d as { debug?: { details?: { title?: unknown; detail?: unknown } } })?.debug?.details;
    const t = `${String(dd?.title ?? '')}: ${String(dd?.detail ?? '')}`.trim();
    if (t !== ':') msg = t.replace(/^[:\s]+|[:\s]+$/g, '');
  }
  const code = typeof f.code === 'string' ? f.code : '';
  if (!msg || msg === 'Error') msg = code;
  if (!code && status >= 200 && status < 300) return { status, message: msg };
  return statusOf(status, code, msg);
}

function statusOf(status: number, code: string, msg: string): CursorFailure {
  const message = msg || `HTTP ${status}`;
  const low = message.toLowerCase();
  if (regional(message)) return { status: 403, message };
  if (code === 'permission_denied') return { status: 403, message };
  if (code === 'unauthenticated' || status === 401 || low.includes('expired')) return { status: 401, message };
  if (
    code === 'resource_exhausted' ||
    low.includes('quota') ||
    low.includes('rate limit') ||
    low.includes('usage limit')
  ) {
    return { status: 429, message };
  }
  if (low.includes('too long') || low.includes('context length') || low.includes('too many tokens')) {
    return { status: 400, message };
  }
  if (code === 'invalid_argument') return { status: 400, message };
  if (code === 'unavailable') return { status: 503, message };
  if (code) return { status: 502, message };
  return { status: status >= 200 && status < 300 ? 502 : status, message };
}

/** Whether a failure is Cursor's "this team is only served in another region". */
export const isRegional = (f: CursorFailure): boolean => regional(f.message);
/** Whether a failure is Cursor's refusal of a model asked for without Max Mode. */
export const isMaxModeRequired = (f: CursorFailure): boolean =>
  /max[ _]mode[ _]required|requires max mode/i.test(f.message);

/** A TurnEndedUpdate as OpenAI usage. Cursor's input_tokens is the whole prompt. */
function usageOf(uf: ReturnType<typeof fields>): TurnUsage {
  return {
    input: pbNum(uf, 1),
    output: pbNum(uf, 2),
    cacheRead: pbNum(uf, 3),
    cacheWrite: pbNum(uf, 4),
    reasoning: pbNum(uf, 5),
  };
}

interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

type Send = (msg: Buffer) => void;

/**
 * Answer what the server asks the client to run. A call of the caller's tools is returned;
 * the tool list and request context are given; anything else (Cursor's own shell / read /
 * edit tools) is refused and never run.
 */
export function exec(
  msg: Buffer,
  tools: CursorTool[],
  send: Send,
): { id: string; name: string; args: string } | null {
  const es = fields(msg);
  const id = pbNum(es, 1);
  const execID = pbStr(es, 15);
  const closeExec = (): void => send(pb().bytes(5, pb().bytes(1, pb().varint(1, id))).done());
  const answer = (num: number, res: ReturnType<typeof pb>): void => {
    send(pb().bytes(2, pb().varint(1, id).str(15, execID).bytes(num, res)).done());
    closeExec();
  };
  for (const e of es) {
    switch (e.num) {
      case 11: {
        // mcp_args: a call of the caller's tools
        const a = fields(e.data);
        const args: Record<string, unknown> = {};
        for (const kv of a) {
          if (kv.num !== 2) continue;
          const ef = fields(kv.data);
          const v = field(ef, 2);
          args[pbStr(ef, 1)] = v ? pbAny(v.data) : null;
        }
        const name = pbStr(a, 5) || pbStr(a, 1).replace(new RegExp(`^${TOOL_NS}-`), '');
        // An OpenAI model's id is its call's and its item's, a line apart: send the line as __.
        const cid = pbStr(a, 3).replaceAll('\n', '__') || 'call_' + randomBytes(12).toString('hex');
        return { id: cid, name, args: JSON.stringify(args) };
      }
      case 36: {
        // mcp_state_exec_args: the tools there are
        const srv = pb().str(1, TOOL_NS).str(2, TOOL_NS).str(7, 'connected');
        for (const t of tools) srv.bytes(5, toolDef(t));
        answer(36, pb().bytes(1, pb().bytes(1, srv)));
        return null;
      }
      case 10: // request_context_args
        answer(10, pb().bytes(1, pb().bytes(1, pb().bytes(4, env()))));
        return null;
    }
  }
  // A shell, a file read, or an edit of Cursor's own: never run.
  send(pb().bytes(5, pb().bytes(2, pb().varint(1, id).str(2, 'not available'))).done());
  closeExec();
  return null;
}

export interface DecodeOptions {
  send: Send;
  blobs: Map<string, Buffer>;
  tools: CursorTool[];
  /** Prompt-size guess used when Cursor reports no usage. */
  estimate: number;
}

const EMPTY_REPLY: CursorFailure = { status: 502, message: 'an empty reply' };

/** Follow the server's messages into the answer's events until the turn ends. */
export async function* decode(
  stream: AsyncIterable<ConnectFrame>,
  { send, blobs, tools, estimate }: DecodeOptions,
): AsyncGenerator<CursorEvent> {
  let calls = 0;
  let answered = 0;
  let listed = 0;
  let said = 0;
  let wrote = 0;
  let usage: TurnUsage | null = null;

  const stepDone = (): boolean => {
    if (!listed || calls + answered < listed) return false;
    if (calls > 0) return true;
    listed = 0;
    answered = 0;
    return false;
  };
  const finish = (): CursorEvent => {
    const input = usage?.input || estimate;
    const output = usage?.output || Math.floor((said + 3) / 4);
    return {
      stop: calls > 0 ? 'tool_calls' : 'stop',
      usage: {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: input + output,
        ...(usage?.cacheRead || usage?.cacheWrite
          ? { prompt_tokens_details: { cached_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite } }
          : {}),
        ...(usage?.reasoning ? { completion_tokens_details: { reasoning_tokens: usage.reasoning } } : {}),
      },
    };
  };

  try {
    for await (const f of stream) {
      if (f.end) {
        const e = failure(200, f.data);
        if (e.status < 200 || e.status > 299) yield { error: e };
        else if (wrote === 0 && calls === 0) yield { error: EMPTY_REPLY };
        else yield finish();
        return;
      }
      for (const m of fields(f.data)) {
        switch (m.num) {
          case 1: // interaction_update
            for (const u of fields(m.data)) {
              const uf = fields(u.data);
              switch (u.num) {
                case 1: {
                  const t = pbStr(uf, 1);
                  if (t) {
                    said += t.length;
                    wrote += t.length;
                    yield { text: t };
                  }
                  break;
                }
                case 4: {
                  const t = pbStr(uf, 1);
                  if (t) {
                    said += t.length;
                    yield { reasoning: t };
                  }
                  break;
                }
                case 14: // turn ended, with what it used
                  usage = usageOf(uf);
                  if (calls === 0) {
                    yield wrote === 0 ? { error: EMPTY_REPLY } : finish();
                    return;
                  }
                  break;
                case 27: // how many tool calls the step makes
                  listed = pbNum(uf, 1);
                  if (stepDone()) {
                    yield finish();
                    return;
                  }
                  break;
              }
            }
            break;
          case 2: {
            // exec_server_message: the server asks the client to run something
            const call = exec(m.data, tools, send);
            if (call) {
              said += call.args.length;
              yield { tool: { index: calls++, ...call } };
            } else if (!fields(m.data).some((e) => e.num === 10)) {
              answered++;
            }
            if (stepDone()) {
              yield finish();
              return;
            }
            break;
          }
          case 4: {
            // kv_server_message: a blob wanted, or one to keep
            const kv = fields(m.data);
            const id = pbNum(kv, 1);
            for (const k of kv) {
              if (k.num === 2) {
                const want = field(fields(k.data), 1)?.data.toString('hex') ?? '';
                const b = blobs.get(want);
                const res = b ? pb().bytes(1, b) : pb().bytes(2, pb().str(1, 'blob not found'));
                send(pb().bytes(3, pb().varint(1, id).bytes(2, res)).done());
              } else if (k.num === 3) {
                send(pb().bytes(3, pb().varint(1, id).bytes(3, EMPTY)).done());
              }
            }
            break;
          }
        }
      }
    }
    if (calls > 0) {
      yield finish();
      return;
    }
    yield { error: { status: 502, message: 'the reply broke off: EOF' } };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (calls > 0 && /EOF/.test(message)) {
      yield finish();
      return;
    }
    yield { error: { status: 502, message: 'the reply broke off' } };
  }
}
