// The translation proxy — a main-process loopback HTTP server that lets an agent
// speaking format X bind to a provider speaking format Y.
//
// SECURITY (see docs/dev-rules/electron-security-and-process-boundaries.md and
// credentials-and-local-storage.md):
//   - Binds ONLY 127.0.0.1 on a fixed loopback port (never 0.0.0.0/::). The port is
//     persisted (proxyStore.ts) and reused across restarts so an agent's cached loopback
//     address keeps resolving; the OS-assigned fallback is used only when it is taken.
//   - The agent's config holds a per-binding loopback TOKEN, never the real key. The
//     real provider key is resolved here at request time via the injected `getKey`
//     thunk (which routes through providerManager, preserving the "only providerManager
//     reads plaintext keys" invariant) and placed into the OUTBOUND headers only.
//   - Tokens are persisted alongside the port so they survive a restart (see proxyStore.ts
//     for why that does not widen exposure). They are class-secret and, like keys, never
//     reach a log or an IPC error.
//   - Logs record method / de-tokenized path / upstream status / byte count ONLY —
//     never the body, auth headers, token, or key. Upstream error bodies are NOT
//     forwarded (they can echo the key); the client sees a generic coded envelope.
//
// This module touches Node http + streams, so it is not unit-tested at the socket
// layer (the pure router / translators / SSE codec it composes are). The transport
// (`ProxyFetch`) and key resolver are injected so it never imports Electron directly.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentId, ApiFormat } from '../../shared/aiProviders';
import { decodeIpcError, encodeIpcError, type IpcErrorCode } from '../../shared/ipc-errors';
import { logger } from '../logger';
import {
  ProxyRouter,
  assertInboundPath,
  parseTokenFromPath,
  type RouteSpec,
} from './router';
import type { ProxyStateStore } from './proxyStore';
import { outboundHeaders, outboundUrl, type ProxyFetch } from './upstream';
import { sanitizeOutboundBody } from './sanitize';
import { SseDecoder, serializeSse, type SseEvent } from './translate/streaming';
import { createUsageSniffer, readResponseUsage } from './usageSniffer';
import type { UsageEventInput } from '../../shared/usageStats';
import {
  createOpenaiToAnthropicStream,
  requestOpenaiToAnthropic,
  responseOpenaiToAnthropic,
} from './translate/openaiToAnthropic';
import {
  createAnthropicToOpenaiStream,
  requestAnthropicToOpenai,
  responseAnthropicToOpenai,
} from './translate/anthropicToOpenai';
import {
  createOpenaiToResponsesStream,
  requestResponsesToOpenai,
  responseOpenaiToResponses,
} from './translate/responsesOpenai';
import {
  createAnthropicToResponsesStream,
  requestResponsesToAnthropic,
  responseAnthropicToResponses,
} from './translate/responsesAnthropic';

export interface TranslationProxyDeps {
  /** Streaming transport (Electron `net.fetch` in production; a stub in tests). */
  fetchImpl: ProxyFetch;
  /** Resolve a provider's real upstream key, main-side, at request time. */
  getKey: (providerId: string) => string | null;
  /**
   * Resolve a provider's configured `dropRequestFields` (see sanitize.ts) at request time,
   * the same way `getKey` resolves its key — read live from the provider record rather than
   * frozen into the route, so editing a provider takes effect on the NEXT request without
   * rebinding the agent or rotating its token. Optional: absent (or returning undefined)
   * means strip nothing, which is the default for every provider.
   */
  getDropFields?: (providerId: string) => readonly string[] | undefined;
  /**
   * Record one upstream attempt (counts + identifiers only; the store stamps `ts`).
   * Optional so existing constructors/tests need not supply it. Never throws into the
   * request path — the proxy wraps every call in a guard.
   */
  recordUsage?: (event: UsageEventInput) => void;
  /**
   * Persisted proxy identity — the fixed port + the live route tokens. Optional so
   * existing constructors/tests need not supply it; when absent the proxy behaves as
   * before (OS-assigned port, in-memory-only tokens that die on restart).
   */
  persistence?: ProxyStateStore;
}

export interface TranslationProxy {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The live listen port; -1 before start. Fixed across restarts when persisted. */
  getPort(): number;
  /**
   * Rebind the loopback server to a FRESH OS-assigned port (always free at that instant) and
   * persist it, WITHOUT dropping any routes — the per-binding tokens are stable identity and
   * survive the move. The new server is bound before the old one is closed, so there is no
   * downtime window. Returns the new port. Caller (providerManager.refreshProxyPort) then
   * replays every binding so each agent's on-disk baseUrl points at the new port. This is the
   * user's manual escape hatch when the persisted port collides with another process.
   */
  rebindPort(): Promise<number>;
  /**
   * Register a route. Returns the loopback base URL to write as the agent's baseUrl AND
   * the per-binding token to write into its key slot (in place of the real key). The token
   * also lives in the base URL's path — that path token is what actually authenticates the
   * request; the key-slot copy just gives the agent a non-empty, non-secret credential to
   * send. The token is STABLE while the binding's target is unchanged (reused, not rotated),
   * so a restart's idempotent replay hands back the address the agent already cached.
   */
  registerRoute(spec: RouteSpec): { baseUrl: string; token: string };
  /** Drop the route for an agent (binding cleared / restored / provider removed). */
  unregisterRoute(spec: Pick<RouteSpec, 'agentId'>): void;
  /** Whether a live route exists for this agent (drives the snapshot `proxied` flag). */
  isRouted(agentId: AgentId): boolean;
  /**
   * The live loopback endpoint for an agent, or null when it has no route. The token is a
   * secret-class value — callers must keep it main-side (never cross it back over IPC to the
   * renderer). `inboundFormat` is the dialect the endpoint speaks, so a copied config can be
   * labeled honestly.
   */
  endpointFor(
    agentId: AgentId,
  ): { baseUrl: string; token: string; modelId: string; inboundFormat: ApiFormat } | null;
}

/** The set of transforms for one route direction. */
interface DirectionTransforms {
  translateRequest: (body: Record<string, unknown>, modelId: string) => Record<string, unknown>;
  translateResponse: (upstream: Record<string, unknown>) => Record<string, unknown>;
  makeStreamTransform: () => (event: SseEvent) => string[];
}

/**
 * Identity transforms for a same-format passthrough route. The proxy forwards the
 * request and response byte-for-byte (re-serialized through the shared codec) and only
 * SNIFFS token usage — it never rewrites the body, and it does NOT force the bound model
 * onto the request, so a same-format binding keeps the agent's freedom to switch models.
 */
const IDENTITY_TRANSFORMS: DirectionTransforms = {
  translateRequest: (body) => body,
  translateResponse: (upstream) => upstream,
  makeStreamTransform: () => (event) => [serializeSse(event)],
};

/** Pick transforms by the route's directed (inbound → outbound) format pair. */
function transformsFor(spec: RouteSpec): DirectionTransforms {
  // Same-format route: identity passthrough (usage still sniffed). Gemini never routes.
  if (spec.inboundFormat === spec.outboundFormat) return IDENTITY_TRANSFORMS;
  const pair = `${spec.inboundFormat}>${spec.outboundFormat}`;
  switch (pair) {
    // Enabled: claude (Anthropic) → OpenAI Chat Completions provider.
    case 'anthropic>openai':
      return {
        translateRequest: (body, modelId) =>
          requestAnthropicToOpenai(body as never, modelId) as unknown as Record<string, unknown>,
        translateResponse: (upstream) =>
          responseOpenaiToAnthropic(upstream as never) as unknown as Record<string, unknown>,
        makeStreamTransform: createOpenaiToAnthropicStream,
      };
    // Reserved: an OpenAI Chat Completions client → Anthropic provider.
    case 'openai>anthropic':
      return {
        translateRequest: (body, modelId) =>
          requestOpenaiToAnthropic(body as never, modelId) as unknown as Record<string, unknown>,
        translateResponse: (upstream) =>
          responseAnthropicToOpenai(upstream as never) as unknown as Record<string, unknown>,
        makeStreamTransform: createAnthropicToOpenaiStream,
      };
    // Enabled: Responses client (codex/grok) → OpenAI Chat Completions provider.
    case 'openai-responses>openai':
      return {
        translateRequest: (body, modelId) =>
          requestResponsesToOpenai(body as never, modelId) as unknown as Record<string, unknown>,
        translateResponse: (upstream) =>
          responseOpenaiToResponses(upstream as never) as unknown as Record<string, unknown>,
        makeStreamTransform: createOpenaiToResponsesStream,
      };
    // Enabled: Responses client (codex/grok) → Anthropic provider, with the reasoning
    // bridge (Claude thinking+signature ↔ Responses reasoning item) folded in.
    case 'openai-responses>anthropic':
      return {
        translateRequest: (body, modelId) =>
          requestResponsesToAnthropic(body as never, modelId) as unknown as Record<string, unknown>,
        translateResponse: (upstream) =>
          responseAnthropicToResponses(upstream as never) as unknown as Record<string, unknown>,
        makeStreamTransform: createAnthropicToResponsesStream,
      };
    // No transform wired for this directed pair. `translationSupported` already gates
    // binding, so a route only reaches here if a pair was enabled there but not here —
    // reject loudly rather than mis-applying a transform to the wrong body shape.
    default:
      throw new Error(
        encodeIpcError(
          'UNSUPPORTED_CAPABILITY',
          `translation for ${spec.inboundFormat} → ${spec.outboundFormat} is not available`,
        ),
      );
  }
}

/** Map a coded error to the HTTP status the client should see. */
function statusForCode(code: IpcErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'UPSTREAM_ERROR':
      return 502;
    case 'INVALID_PARAMS':
    case 'UNSUPPORTED_CAPABILITY':
    case 'PRECONDITION_FAILED':
      return 400;
    case 'NOT_FOUND':
      return 404;
    default:
      return 500;
  }
}

/** Build a native-format error envelope (generic, key-free message). */
function errorEnvelope(format: ApiFormat, message: string): unknown {
  if (format === 'anthropic') {
    return { type: 'error', error: { type: 'invalid_request_error', message } };
  }
  // openai (and any non-anthropic inbound)
  return { error: { message, type: 'invalid_request_error' } };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/** Await backpressure drain so a fast upstream can't outrun a slow client. */
function writeBackpressured(res: ServerResponse, chunk: string): Promise<void> {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => res.once('drain', () => resolve()));
}

/** Read the full request body as a UTF-8 string (requests are small JSON documents). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createTranslationProxy(deps: TranslationProxyDeps): TranslationProxy {
  // Rehydrate any persisted routes so a restart resolves the tokens agents already cached.
  const router = new ProxyRouter(deps.persistence?.loadRoutes());
  let server: Server | null = null;
  let port = -1;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { token, rest } = parseTokenFromPath(req.url ?? '/');
    const spec = router.resolve(token);
    if (!spec) {
      // Unknown/missing token: we cannot know the inbound format, so answer generically.
      logger.warn('proxy.reject', { reason: 'unknown_token', path: rest });
      sendJson(res, 401, errorEnvelope('openai', 'invalid or expired proxy token'));
      return;
    }

    const inbound = spec.inboundFormat;

    // Record one upstream attempt (counts + ids only). Never disturbs the request path.
    const record = (
      streamed: boolean,
      ok: boolean,
      status: number,
      counts: { inputTokens: number; outputTokens: number },
    ): void => {
      if (!deps.recordUsage) return;
      try {
        deps.recordUsage({
          agentId: spec.agentId,
          providerId: spec.providerId,
          model: spec.modelId,
          inboundFormat: spec.inboundFormat,
          outboundFormat: spec.outboundFormat,
          streamed,
          ok,
          status,
          inputTokens: counts.inputTokens,
          outputTokens: counts.outputTokens,
        });
      } catch {
        // Usage recording is best-effort; swallow so it can't fail a real request.
      }
    };
    const noTokens = { inputTokens: 0, outputTokens: 0 };

    try {
      assertInboundPath(spec, rest);
      const raw = await readBody(req);
      let parsed: Record<string, unknown>;
      try {
        parsed = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      } catch {
        throw new Error(encodeIpcError('INVALID_PARAMS', 'request body is not valid JSON'));
      }

      const tf = transformsFor(spec);
      const translatedRequest = tf.translateRequest(parsed, spec.modelId);
      // Strip whatever fields THIS provider's upstream is configured to reject (see
      // sanitize.ts). Runs after translation so a cross-format route sanitizes the body
      // that actually goes on the wire, and so the translators' explicit refusal of an
      // untranslatable field still happens first. Field NAMES only in the log — values
      // can be arbitrary user content.
      const { body: outboundBody, dropped } = sanitizeOutboundBody(
        translatedRequest,
        deps.getDropFields?.(spec.providerId),
      );
      if (dropped.length > 0) {
        logger.info('proxy.request_sanitized', { path: rest, fields: dropped });
      }
      const wantsStream = (outboundBody as { stream?: unknown }).stream === true;

      // OpenAI Chat streaming omits `usage` unless the request opts in. Inject the standard
      // flag so codex/opencode → OpenAI-Chat streaming paths still yield token counts. This
      // is additive and reversible; a provider that rejects it degrades to request-count-only.
      if (wantsStream && spec.outboundFormat === 'openai') {
        const existing = (outboundBody.stream_options ?? {}) as Record<string, unknown>;
        outboundBody.stream_options = { ...existing, include_usage: true };
      }

      const apiKey = deps.getKey(spec.providerId);
      const url = outboundUrl(spec.outboundFormat, spec.upstreamBaseUrl);
      const headers = outboundHeaders(spec.outboundFormat, apiKey);

      const controller = new AbortController();
      req.on('close', () => controller.abort());

      const upstream = await deps
        .fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(outboundBody), signal: controller.signal })
        .catch(() => {
          record(wantsStream, false, 0, noTokens);
          throw new Error(encodeIpcError('UPSTREAM_ERROR', 'could not reach the provider'));
        });

      if (upstream.status === 401 || upstream.status === 403) {
        record(wantsStream, false, upstream.status, noTokens);
        logger.warn('proxy.upstream', { path: rest, status: upstream.status });
        sendJson(res, 401, errorEnvelope(inbound, 'the provider rejected the API key'));
        return;
      }
      if (!upstream.ok) {
        // Never forward the upstream body (may reflect the key); status is safe.
        record(wantsStream, false, upstream.status, noTokens);
        logger.warn('proxy.upstream', { path: rest, status: upstream.status });
        sendJson(res, 502, errorEnvelope(inbound, `the provider returned status ${upstream.status}`));
        return;
      }

      if (wantsStream) {
        const sniffer = createUsageSniffer(spec.outboundFormat);
        await pipeStream(res, upstream.body, tf, inbound, rest, upstream.status, sniffer);
        record(true, true, upstream.status, sniffer.result());
      } else {
        const text = await upstream.text();
        let upstreamJson: Record<string, unknown>;
        try {
          upstreamJson = JSON.parse(text) as Record<string, unknown>;
        } catch {
          throw new Error(encodeIpcError('UPSTREAM_ERROR', 'the provider returned an unreadable response'));
        }
        const translated = tf.translateResponse(upstreamJson);
        record(false, true, upstream.status, readResponseUsage(spec.outboundFormat, upstreamJson));
        logger.info('proxy.request', { path: rest, status: upstream.status, stream: false });
        sendJson(res, 200, translated);
      }
    } catch (err) {
      const { code, message } = decodeIpcError(err instanceof Error ? err.message : String(err));
      logger.warn('proxy.error', { path: rest, code });
      if (!res.headersSent) sendJson(res, statusForCode(code), errorEnvelope(inbound, message));
      else res.end();
    }
  }

  async function pipeStream(
    res: ServerResponse,
    body: ReadableStream<Uint8Array> | null,
    tf: DirectionTransforms,
    inbound: ApiFormat,
    path: string,
    status: number,
    sniffer?: { observe: (event: SseEvent) => void },
  ): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    if (!body) {
      res.end();
      return;
    }
    const decoder = new SseDecoder();
    const transform = tf.makeStreamTransform();
    const textDecoder = new TextDecoder();
    const reader = body.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) bytes += value.byteLength;
        const text = textDecoder.decode(value ?? new Uint8Array(), { stream: true });
        for (const event of decoder.push(text)) {
          sniffer?.observe(event);
          for (const frame of transform(event)) await writeBackpressured(res, frame);
        }
      }
      for (const event of decoder.flush()) {
        sniffer?.observe(event);
        for (const frame of transform(event)) await writeBackpressured(res, frame);
      }
    } catch {
      // Client aborted or upstream stream broke; nothing safe to add to the wire.
    } finally {
      logger.info('proxy.request', { path, status, stream: true, bytes });
      res.end();
    }
  }

  // Bind a NEW loopback server on `wanted` (0 = OS-assigned). On EADDRINUSE/EACCES with
  // allowFallback, retry once on an OS-assigned port. Resolves with the freshly bound server
  // WITHOUT installing it as the live one — the caller decides when to swap `server`/`port`
  // (so a rebind can bind-before-close for zero downtime). Loopback only — never 0.0.0.0/::.
  function bind(wanted: number, allowFallback: boolean): Promise<Server> {
    return new Promise<Server>((resolve, reject) => {
      const attempt = (target: number, retry: boolean): void => {
        const srv = createServer((req, res) => {
          void handle(req, res);
        });
        const onError = (err: NodeJS.ErrnoException): void => {
          srv.removeListener('error', onError);
          if (retry && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
            logger.warn('proxy.port_unavailable', { wanted: target, code: err.code });
            attempt(0, false); // OS-assigned fallback; do not recurse again
          } else {
            reject(err);
          }
        };
        srv.on('error', onError);
        srv.listen(target, '127.0.0.1', () => {
          srv.removeListener('error', onError);
          resolve(srv);
        });
      };
      attempt(wanted, allowFallback);
    });
  }

  return {
    async start() {
      if (server) return;
      const persistedPort = deps.persistence?.loadPort() ?? null;
      // A valid persisted port → try it with a fallback; none → straight to OS-assigned.
      const srv = persistedPort !== null ? await bind(persistedPort, true) : await bind(0, false);
      server = srv;
      port = (srv.address() as AddressInfo).port;
      // Record the port we actually bound so the next launch reuses it.
      deps.persistence?.savePort(port);
      logger.info('proxy.start', { port });
    },

    async rebindPort() {
      if (!server) {
        throw new Error(encodeIpcError('INTERNAL', 'translation proxy is not started'));
      }
      // Bind the replacement on a fresh OS-assigned port BEFORE tearing the old one down, so
      // in-flight requests on the old listener are never refused mid-swap. Routes/tokens are
      // untouched — only the port moves.
      const next = await bind(0, false);
      const previous = server;
      server = next;
      port = (next.address() as AddressInfo).port;
      deps.persistence?.savePort(port);
      logger.info('proxy.rebind', { port });
      // Close the old listener; it stops accepting new sockets and drains existing ones.
      previous.close();
      return port;
    },

    stop() {
      const srv = server;
      if (!srv) return Promise.resolve();
      server = null;
      port = -1;
      router.clear();
      return new Promise<void>((resolve) => {
        srv.close(() => {
          logger.info('proxy.stop');
          resolve();
        });
      });
    },

    getPort() {
      return port;
    },

    registerRoute(spec) {
      if (port < 0) {
        throw new Error(encodeIpcError('INTERNAL', 'translation proxy is not started'));
      }
      const token = router.register(spec);
      // Persist the updated route set so a restart rehydrates the same token.
      deps.persistence?.saveRoutes(router.snapshot());
      return { baseUrl: `http://127.0.0.1:${port}/${token}`, token };
    },

    unregisterRoute(spec) {
      router.unregister(spec.agentId);
      deps.persistence?.saveRoutes(router.snapshot());
    },

    isRouted(agentId) {
      return router.has(agentId);
    },

    endpointFor(agentId) {
      if (port < 0) return null;
      const route = router.routeFor(agentId);
      if (!route) return null;
      return {
        baseUrl: `http://127.0.0.1:${port}/${route.token}`,
        token: route.token,
        modelId: route.spec.modelId,
        inboundFormat: route.spec.inboundFormat,
      };
    },
  };
}
