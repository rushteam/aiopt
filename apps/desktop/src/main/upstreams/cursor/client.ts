// Cursor agent API client — the one place AiOpt talks to Cursor with a signed-in
// cursor-agent session's bearer token.
//
// - Unary Connect-JSON calls (server config, model picker, usable models) go over the
//   injected `ProxyFetch` (Electron `net.fetch` in production; a stub in tests).
// - The chat itself is `agent.v1.AgentService/Run`, a bidirectional Connect stream that
//   needs HTTP/2 (`node:http2`; the connector is injectable for tests).
//
// The token lives only in this process's memory for the request's lifetime. Nothing here
// logs headers, the token, or Cursor's raw error text — callers get a status + a message
// they must keep main-side (see credentials-and-local-storage.md).
//
// Not implemented: an HTTP/1.1 RunSSE+BidiAppend fallback and native session retention.

import { createHash, randomUUID } from 'node:crypto';
import http2 from 'node:http2';
import type { ProxyFetch } from '../../proxy/upstream';
import { UpstreamError } from '../types';
import {
  buildRun,
  conversation,
  conversationID,
  toolsOf,
  type ChatRequest,
} from './conversation';
import { decode, failure, isMaxModeRequired, isRegional, type CursorEvent, type CursorFailure } from './decode';
import { modelsOf, requestModel, type OfferedModel } from './models';
import { connectFrame, connectFrames, pb } from './protobuf';

export const CURSOR_API = 'https://api2.cursor.sh';
export const CURSOR_AGENT = 'https://agentn.global.api5.cursor.sh';
const EMPTY = Buffer.alloc(0);
const HEAD_WAIT_MS = 15_000;
const HEARTBEAT_MS = 5_000;
const MODELS_KEEP_MS = 10 * 60_000;
const MAX_ERROR_BODY = 1 << 20;

/**
 * The HTTP/2 connect function (node:http2's, a proxy-tunnelling one — see
 * ../http2Proxy.ts — or a test double). May resolve asynchronously (a proxy lookup).
 */
export type Http2Connect = (authority: string) => http2.ClientHttp2Session | Promise<http2.ClientHttp2Session>;

export interface CursorClientDeps {
  fetchImpl: ProxyFetch;
  /** `cli-<version>` for x-cursor-client-version. */
  clientVersion: () => string;
  connect?: Http2Connect;
  /** Agent API base override (tests). Skips GetServerConfig when set. */
  agentBase?: string;
  now?: () => number;
}

export type CursorChatResult = { error: CursorFailure } | { events: AsyncIterable<CursorEvent> };

export interface CursorClient {
  /** The account's models (picker less what it is not served), cached per token. */
  models(token: string, signal?: AbortSignal): Promise<OfferedModel[]>;
  /** One OpenAI chat request answered by Cursor. */
  chat(token: string, chat: ChatRequest, signal?: AbortSignal): Promise<CursorChatResult>;
}

const tokenKey = (tok: string): string => createHash('sha256').update(tok).digest('hex');

export function createCursorClient(deps: CursorClientDeps): CursorClient {
  const now = deps.now ?? Date.now;
  const connect: Http2Connect = deps.connect ?? ((authority) => http2.connect(authority));
  const endpoints = new Map<string, { url: string; at: number; listed: boolean }>();
  const lists = new Map<string, { at: number; raw: OfferedModel[] }>();
  const maxOnly = new Set<string>();

  function jsonHeaders(tok: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      authorization: `Bearer ${tok}`,
      'x-cursor-client-version': deps.clientVersion(),
      'x-cursor-client-type': 'cli',
      'x-ghost-mode': 'true',
    };
  }

  async function unary(path: string, tok: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res;
    try {
      res = await deps.fetchImpl(`${CURSOR_API}/${path}`, {
        method: 'POST',
        headers: jsonHeaders(tok),
        body: JSON.stringify(body ?? {}),
        signal: sig,
      });
    } catch {
      throw new UpstreamError({ status: 502, message: 'network error' });
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new UpstreamError(failure(res.status, text.slice(0, MAX_ERROR_BODY)));
    try {
      return text ? (JSON.parse(text) as unknown) : {};
    } catch {
      throw new UpstreamError({ status: 502, message: 'malformed response' });
    }
  }

  async function agentURL(tok: string, fresh: boolean): Promise<string> {
    if (deps.agentBase) return deps.agentBase;
    const key = tokenKey(tok);
    const had = endpoints.get(key);
    if (!fresh && had && (had.listed || now() - had.at < 60_000)) return had.url;
    let url = CURSOR_AGENT;
    let listed = false;
    try {
      const cfg = (await unary('aiserver.v1.ServerConfigService/GetServerConfig', tok, {}, 10_000)) as {
        agentUrlConfig?: { agentUrl?: unknown; agentnUrl?: unknown };
      };
      for (const raw of [cfg?.agentUrlConfig?.agentUrl, cfg?.agentUrlConfig?.agentnUrl]) {
        if (typeof raw !== 'string') continue;
        try {
          const u = new URL(raw);
          if (u.protocol === 'https:' && u.host) {
            url = raw.replace(/\/+$/, '');
            listed = true;
            break;
          }
        } catch {
          // not a URL
        }
      }
    } catch {
      // keep the global endpoint
    }
    endpoints.set(key, { url, at: now(), listed });
    return url;
  }

  async function models(tok: string, signal?: AbortSignal): Promise<OfferedModel[]> {
    const key = tokenKey(tok);
    const had = lists.get(key);
    if (had && now() - had.at < MODELS_KEEP_MS) return had.raw;
    const [picker, ids] = await Promise.all([
      unary(
        'aiserver.v1.AiService/AvailableModels',
        tok,
        { useModelParameters: true, doNotUseMarkdown: true },
        30_000,
        signal,
      ) as Promise<{ models?: unknown }>,
      (unary('agent.v1.AgentService/GetUsableModels', tok, {}, 8_000, signal) as Promise<{ models?: unknown }>).then(
        (u) => {
          const list = Array.isArray(u?.models) ? (u.models as Array<{ modelId?: unknown; displayModelId?: unknown }>) : [];
          const s = new Set(
            list.flatMap((m) => [m.modelId, m.displayModelId]).filter((x): x is string => typeof x === 'string' && x !== ''),
          );
          return s.size ? s : null;
        },
        () => null,
      ),
    ]);
    const raw = modelsOf(Array.isArray(picker?.models) ? (picker.models as never[]) : [], ids);
    if (raw.length === 0) throw new UpstreamError({ status: 502, message: 'no models listed' });
    lists.set(key, { at: now(), raw });
    return raw;
  }

  interface Opened {
    session: http2.ClientHttp2Session;
    req: http2.ClientHttp2Stream;
    status: number;
  }

  function open(base: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Opened | { error: CursorFailure }> {
    if (signal?.aborted) return Promise.resolve({ error: { status: 410, message: 'cancelled' } });
    const u = new URL(base);
    return Promise.resolve()
      .then(() => connect(u.origin))
      .then(
        (session) => {
          if (!signal?.aborted) return request(u, session, headers, signal);
          session.destroy();
          return { error: { status: 410, message: 'cancelled' } };
        },
        () => ({ error: { status: 502, message: 'connect failed' } }),
      );
  }

  function request(
    u: URL,
    session: http2.ClientHttp2Session,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Opened | { error: CursorFailure }> {
    return new Promise((resolve) => {
      let done = false;
      const fail = (message: string, status = 502): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        session.destroy();
        resolve({ error: { status, message } });
      };
      const abort = (): void => fail('cancelled', 410);
      const timer = setTimeout(() => fail('no response head in time'), HEAD_WAIT_MS);
      session.on('error', () => fail('connection error'));
      const req = session.request({
        ':method': 'POST',
        ':path': u.pathname.replace(/\/+$/, '') + '/agent.v1.AgentService/Run',
        ...headers,
      });
      req.on('error', () => fail('stream error'));
      req.once('close', () => fail('stream closed before its response'));
      req.once('response', (h) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve({ session, req, status: Number(h[':status']) });
      });
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  interface RunArgs {
    tok: string;
    base: string;
    id: string;
    maxMode: boolean;
    params: Array<{ id: string; value: string }>;
    chat: ChatRequest;
    signal?: AbortSignal;
  }

  async function runOnce(a: RunArgs): Promise<CursorChatResult> {
    const tools = toolsOf(a.chat);
    const conv = conversation(a.chat, tools);
    const { first, blobs } = buildRun(conv, tools, a.id, conversationID(a.chat), {
      maxMode: a.maxMode,
      params: a.params,
    });
    const o = await open(
      a.base,
      {
        'content-type': 'application/connect+proto',
        'connect-protocol-version': '1',
        authorization: `Bearer ${a.tok}`,
        'x-cursor-client-version': deps.clientVersion(),
        'x-cursor-client-type': 'cli', // else Cursor adds a prompt of its own
        'x-ghost-mode': 'true', // privacy mode: nothing kept for training
        'x-request-id': randomUUID(),
        // none of Cursor's own tools, only the caller's
        'x-cursor-agent-allowed-tools': 'mcp_tool_call,get_mcp_tools_tool_call',
      },
      a.signal,
    );
    if ('error' in o) return o;
    const { session, req } = o;
    let closed = false;
    const send = (msg: Buffer): void => {
      if (!closed && !req.destroyed && req.writable) req.write(connectFrame(msg));
    };
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      a.signal?.removeEventListener('abort', close);
      try {
        req.close(http2.constants.NGHTTP2_CANCEL);
      } catch {
        // already closed
      }
      session.close();
      setTimeout(() => session.destroy(), 1000).unref?.();
    };
    a.signal?.addEventListener('abort', close, { once: true });
    const heartbeat = setInterval(() => send(pb().bytes(7, EMPTY).done()), HEARTBEAT_MS);
    heartbeat.unref?.();
    send(first);
    if (o.status < 200 || o.status > 299) {
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const c of req as AsyncIterable<Buffer>) {
          if (size < MAX_ERROR_BODY) chunks.push(c);
          size += c.length;
        }
      } catch {
        // body cut off
      }
      close();
      return { error: failure(o.status, Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY)) };
    }
    const it = decode(connectFrames(req as AsyncIterable<Buffer>), {
      send,
      blobs,
      tools,
      estimate: conv.estimate,
    });
    // The first event decides whether the Run failed before any output (so it can be
    // retried in another region / in Max Mode) or is an answer to stream.
    const head = await it.next();
    if (head.done || 'error' in head.value) {
      close();
      return { error: head.done ? { status: 502, message: 'an empty reply' } : (head.value as { error: CursorFailure }).error };
    }
    const firstEvent = head.value;
    async function* events(): AsyncGenerator<CursorEvent> {
      try {
        yield firstEvent;
        for (;;) {
          const n = await it.next();
          if (n.done) return;
          yield n.value;
          if ('stop' in n.value || 'error' in n.value) return;
        }
      } finally {
        close();
        await it.return(undefined);
      }
    }
    return { events: events() };
  }

  async function chat(tok: string, chatReq: ChatRequest, signal?: AbortSignal): Promise<CursorChatResult> {
    let raw: OfferedModel[] = [];
    try {
      raw = await models(tok, signal);
    } catch {
      // ask for the model as named
    }
    const tier = chatReq.service_tier;
    const fast = tier === 'priority' || tier === 'fast' ? true : tier ? false : undefined;
    const effort = typeof chatReq.reasoning_effort === 'string' ? chatReq.reasoning_effort : '';
    const req = requestModel(raw, String(chatReq.model ?? ''), effort, fast);
    let maxMode = req.maxMode || maxOnly.has(req.id);
    let base = await agentURL(tok, false);
    const once = (): Promise<CursorChatResult> =>
      runOnce({ tok, base, id: req.id, maxMode, params: req.params, chat: chatReq, signal });
    let r = await once();
    if ('error' in r && isRegional(r.error) && !signal?.aborted) {
      // the team moved, or the config was kept from before: once more with what it says now
      const fresh = await agentURL(tok, true);
      if (fresh !== base) {
        base = fresh;
        r = await once();
      }
    }
    if ('error' in r && !maxMode && isMaxModeRequired(r.error) && !signal?.aborted) {
      maxMode = true;
      maxOnly.add(req.id);
      r = await once();
    }
    return r;
  }

  return {
    async models(token, signal) {
      return models(token, signal);
    },
    chat,
  };
}
