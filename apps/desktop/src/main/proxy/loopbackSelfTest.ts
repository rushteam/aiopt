// In-process loopback self-test: listen on 127.0.0.1 and connect to ourselves.
//
// Windows Defender Firewall's default "query user" policy can drop inbound connections —
// 127.0.0.1 included — to a program that has no inbound allow rule. When that happens
// every agent routed through the translation proxy just sees "connection failed", with
// nothing pointing at the cause. libuv disables SYN retransmission for loopback connects
// on Windows, so a dropped connect fails with ETIMEDOUT quickly instead of hanging; that
// (or our own timer firing before any connect) is the "blocked" signal. A refusal / reset
// comes from something else and is reported as inconclusive.
//
// DIAGNOSE ONLY. This never adds a firewall rule or elevates: changing the system firewall
// is the user's decision, made in Windows' own UI. The result carries an outcome and a
// socket error code — no address beyond 127.0.0.1, nothing identifying.

import net from 'node:net';

export type LoopbackOutcome = 'ok' | 'blocked' | 'inconclusive';

export interface LoopbackSelfTestResult {
  outcome: LoopbackOutcome;
  /** Socket error code, or 'TIMEOUT' when our timer fired first. */
  code?: string;
  elapsedMs: number;
}

export interface LoopbackSelfTestOptions {
  timeoutMs?: number;
  /** Test seam: the client side of the connection. */
  connect?: (port: number, host: string) => net.Socket;
  now?: () => number;
}

const HOST = '127.0.0.1';

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'UNKNOWN';
}

export function runLoopbackSelfTest(options: LoopbackSelfTestOptions = {}): Promise<LoopbackSelfTestResult> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const connect = options.connect ?? ((port: number, host: string) => net.connect({ port, host }));
  const now = options.now ?? Date.now;
  const startedAt = now();

  return new Promise((resolve) => {
    const server = net.createServer();
    let client: net.Socket | null = null;
    let accepted: net.Socket | null = null;
    let connected = false;
    let settled = false;

    const finish = (outcome: LoopbackOutcome, code?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.destroy();
      accepted?.destroy();
      server.close();
      resolve({ outcome, ...(code ? { code } : {}), elapsedMs: now() - startedAt });
    };
    const finishIfBothSides = (): void => {
      if (connected && accepted) finish('ok');
    };

    const timer = setTimeout(() => {
      // A stalled event loop can fire this before an already-completed connect is
      // processed; give the poll phase one turn before deciding.
      setImmediate(() => finish(client && !connected ? 'blocked' : 'inconclusive', 'TIMEOUT'));
    }, timeoutMs);

    server.on('connection', (socket) => {
      accepted = socket;
      socket.on('error', () => {
        /* finish() destroys it */
      });
      finishIfBothSides();
    });
    server.on('error', (err) => finish('inconclusive', errorCode(err)));
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        finish('inconclusive', 'NO_ADDRESS');
        return;
      }
      client = connect(address.port, HOST);
      client.on('connect', () => {
        connected = true;
        finishIfBothSides();
      });
      client.on('error', (err) => {
        const code = errorCode(err);
        finish(code === 'ETIMEDOUT' ? 'blocked' : 'inconclusive', code);
      });
    });
  });
}

/**
 * Run the self-test up to `attempts` times, reporting blocked only when EVERY attempt was
 * dropped — one slow connect on a busy machine must not raise a firewall warning.
 */
export async function detectLoopbackBlock(
  options: LoopbackSelfTestOptions & { attempts?: number; retryDelayMs?: number } = {},
): Promise<LoopbackSelfTestResult> {
  const attempts = Math.max(1, options.attempts ?? 2);
  let last: LoopbackSelfTestResult = { outcome: 'inconclusive', elapsedMs: 0 };
  for (let i = 0; i < attempts; i++) {
    last = await runLoopbackSelfTest(options);
    if (last.outcome !== 'blocked') return last;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, options.retryDelayMs ?? 500));
  }
  return last;
}
