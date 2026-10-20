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

import { timingSafeEqual } from 'node:crypto';
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
import { geminiOutboundUrl, outboundHeaders, outboundUrl, type ProxyFetch } from './upstream';
import { sanitizeOutboundBody } from './sanitize';
import { applyExtraBody, autoFixRequest } from './requestFixes';
import { injectPromptCache } from './promptCache';
import { SseDecoder, serializeSse, type SseEvent } from './translate/streaming';
import { createUsageSniffer, readResponseUsage, zeroUsage, type UsageCounts } from './usageSniffer';
import type { BoundUpstream } from '../upstreams/types';
import { clientMessage, collectCompletion, createChunkMapper, newCompletionIdentity } from '../upstreams/openaiChatOut';
import {
  createGeminiToAnthropicStream,
  createGeminiToOpenaiStream,
  requestAnthropicToGemini,
  requestOpenaiToGemini,
  responseGeminiToAnthropic,
  responseGeminiToOpenai,
} from './translate/gemini';
import type { UsageEventInput } from '../../shared/usageStats';
import {
  shouldFailoverStatus,
  type RoutingCandidate,
  type RoutingStrategy,
} from '../../shared/routingGroups';
import type { RoutingRuntime } from './routing/runtime';
import { splitSeat, type RoutingAttempt } from '../../shared/routingStatus';
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
   * Resolve a provider's `extraBody` (JSON merged into the outbound body; see
   * requestFixes.ts), live like `getDropFields`. Absent / undefined = merge nothing.
   */
  getExtraBody?: (providerId: string) => Record<string, unknown> | undefined;
  /**
   * Whether to add prompt-cache breakpoints to an Anthropic-format outbound body that has
   * none (see promptCache.ts). Read live per request; absent means off.
   */
  getPromptCache?: () => boolean;
  /** Extra outbound headers for a provider (imported sign-ins that want the key both ways). */
  getExtraHeaders?: (providerId: string, apiKey: string | null) => Record<string, string>;
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
  /**
   * Upstream drivers (see main/upstreams/). A provider a driver serves is answered by the
   * driver instead of an HTTP POST: the request is first translated to OpenAI Chat (the
   * route's outbound format) and the driver's answer comes back as OpenAI Chat, so every
   * inbound dialect reuses the existing translators. Looked up per request (live, like
   * {@link getKey}); optional — absent or null = the plain HTTP path.
   */
  upstreamFor?: (providerId: string) => BoundUpstream | null;
  /**
   * The MCP gateway (docs/dev-rules/mcp-gateway.md), served on this same loopback
   * listener under its own path token. Checked before route tokens; absent = no gateway.
   */
  gateway?: ProxyGatewayHook;
  /**
   * Routing-group expansion + strategy / affinity / cooldown. Looked up per request when
   * {@link RouteSpec.routingGroupId} is set. Absent → a group route answers 502.
   */
  routing?: RoutingRuntime;
}

/** The MCP gateway as the proxy sees it: its live token and a request handler. */
export interface ProxyGatewayHook {
  /** The current gateway path token, or null while the gateway is off. */
  token(): string | null;
  handle(req: IncomingMessage, res: ServerResponse, rest: string): Promise<void>;
}

/** Constant-time string compare, so the gateway token cannot be probed by timing. */
function sameToken(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
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
  translateResponse: (upstream: Record<string, unknown>, modelId: string) => Record<string, unknown>;
  /**
   * A per-stream transform. `flush` (optional) runs once the upstream stream ends, for
   * dialects with no terminating event of their own (Gemini), so the client still sees
   * its end-of-message frames.
   */
  makeStreamTransform: (modelId: string) => ((event: SseEvent) => string[]) & { flush?: () => string[] };
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
  // Same-format route: identity passthrough (usage still sniffed).
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
    // Anthropic client (claude) → Gemini provider (generateContent).
    case 'anthropic>gemini':
      return {
        translateRequest: (body) => requestAnthropicToGemini(body as never) as unknown as Record<string, unknown>,
        translateResponse: (upstream, modelId) =>
          responseGeminiToAnthropic(upstream as never, modelId) as unknown as Record<string, unknown>,
        makeStreamTransform: createGeminiToAnthropicStream,
      };
    // Chat Completions client → Gemini provider (generateContent).
    case 'openai>gemini':
      return {
        translateRequest: (body) => requestOpenaiToGemini(body as never) as unknown as Record<string, unknown>,
        translateResponse: (upstream, modelId) =>
          responseGeminiToOpenai(upstream as never, modelId) as unknown as Record<string, unknown>,
        makeStreamTransform: createGeminiToOpenaiStream,
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

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(payload);
}

/**
 * An upstream `Retry-After`, passed on only when it is a plain delay (seconds, capped at a
 * day) or a valid HTTP date — never an arbitrary string an upstream could smuggle through.
 */
export function safeRetryAfter(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d{1,6}$/.test(v)) return String(Math.min(Number(v), 86_400));
  if (v.length <= 64 && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v) && !Number.isNaN(Date.parse(v))) {
    return v;
  }
  return null;
}

/**
 * Upstream statuses the agent should see as-is (so it backs off) rather than as a generic
 * 502: rate limited (429) and overloaded (529, Anthropic's). The body stays generic.
 */
const PASSTHROUGH_STATUS: ReadonlySet<number> = new Set([429, 529]);

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
    const gatewayToken = deps.gateway?.token() ?? null;
    if (deps.gateway && gatewayToken && token !== '' && sameToken(token, gatewayToken)) {
      await deps.gateway.handle(req, res, rest);
      return;
    }
    const spec = router.resolve(token);
    if (!spec) {
      // Unknown/missing token: we cannot know the inbound format, so answer generically.
      logger.warn('proxy.reject', { reason: 'unknown_token', path: rest });
      sendJson(res, 401, errorEnvelope('openai', 'invalid or expired proxy token'));
      return;
    }

    const inbound = spec.inboundFormat;
    const noTokens = zeroUsage();
    const requestStart = Date.now();
    // Routing status trail: one entry per upstream attempt (ids / status / ms only).
    const trail: RoutingAttempt[] = [];
    let attemptStart = requestStart;
    let decision: { groupId: string; strategy: RoutingStrategy; sticky: boolean } | null = null;

    /** Record one upstream attempt against the seat that actually answered (or failed). */
    const recordFor = (
      candidate: RoutingCandidate,
      streamed: boolean,
      ok: boolean,
      status: number,
      counts: UsageCounts,
    ): void => {
      if (decision) {
        trail.push({ ...splitSeat(candidate.seat), status, ok, ms: Date.now() - attemptStart });
      }
      if (!deps.recordUsage) return;
      try {
        deps.recordUsage({
          agentId: spec.agentId,
          providerId: candidate.providerId,
          model: candidate.modelId,
          inboundFormat: spec.inboundFormat,
          outboundFormat: candidate.outboundFormat,
          streamed,
          ok,
          status,
          inputTokens: counts.inputTokens,
          outputTokens: counts.outputTokens,
          cacheReadTokens: counts.cacheReadTokens,
          cacheWriteTokens: counts.cacheWriteTokens,
          reasoningTokens: counts.reasoningTokens,
        });
      } catch {
        // Usage recording is best-effort; swallow so it can't fail a real request.
      }
    };

    try {
      assertInboundPath(spec, rest);
      const raw = await readBody(req);
      let parsed: Record<string, unknown>;
      try {
        parsed = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      } catch {
        throw new Error(encodeIpcError('INVALID_PARAMS', 'request body is not valid JSON'));
      }

      // Build the try-order. A plain binding is one candidate; a routing group expands.
      let conversationKey: string | null = null;
      let groupId: string | undefined = spec.routingGroupId;
      let candidates: RoutingCandidate[];
      if (groupId) {
        const planned = deps.routing?.plan(
          groupId,
          spec.agentId,
          inbound,
          { get: (n) => req.headers[n.toLowerCase()]?.toString() ?? null },
          parsed,
        );
        if (!planned || planned.candidates.length === 0) {
          sendJson(res, 502, errorEnvelope(inbound, 'routing group has no reachable members'));
          return;
        }
        candidates = planned.candidates;
        conversationKey = planned.conversationKey;
        decision = { groupId, strategy: planned.group.strategy, sticky: planned.sticky === true };
      } else {
        candidates = [
          {
            seat: `${spec.providerId}\u241f${spec.modelId}`,
            providerId: spec.providerId,
            modelId: spec.modelId,
            outboundFormat: spec.outboundFormat,
            upstreamBaseUrl: spec.upstreamBaseUrl,
          },
        ];
      }

      const controller = new AbortController();
      req.on('close', () => controller.abort());

      let lastFailure: { candidate: RoutingCandidate; status: number; retryAfter: string | null } | null =
        null;

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]!;
        const more = i < candidates.length - 1;
        attemptStart = Date.now();
        const liveSpec: RouteSpec = {
          ...spec,
          providerId: candidate.providerId,
          outboundFormat: candidate.outboundFormat,
          upstreamBaseUrl: candidate.upstreamBaseUrl,
          modelId: candidate.modelId,
        };
        const tf = transformsFor(liveSpec);
        const translatedRequest = tf.translateRequest(parsed, candidate.modelId);
        const extra = applyExtraBody(translatedRequest, deps.getExtraBody?.(candidate.providerId));
        if (extra.keys.length > 0) {
          logger.info('proxy.request_extra_body', { path: rest, fields: extra.keys });
        }
        const { body: sanitizedBody, dropped } = sanitizeOutboundBody(
          extra.body,
          deps.getDropFields?.(candidate.providerId),
        );
        if (dropped.length > 0) {
          logger.info('proxy.request_sanitized', { path: rest, fields: dropped });
        }
        let outboundBody = sanitizedBody;
        if (candidate.outboundFormat === 'anthropic' && deps.getPromptCache?.() === true) {
          const cached = injectPromptCache(sanitizedBody);
          outboundBody = cached.body;
          if (cached.added > 0) {
            logger.info('proxy.prompt_cache', { path: rest, breakpoints: cached.added });
          }
        }
        const wantsStream =
          candidate.outboundFormat === 'gemini'
            ? parsed.stream === true
            : (outboundBody as { stream?: unknown }).stream === true;
        if (wantsStream && candidate.outboundFormat === 'openai') {
          const existing = (outboundBody.stream_options ?? {}) as Record<string, unknown>;
          outboundBody.stream_options = { ...existing, include_usage: true };
        }

        const driver = deps.upstreamFor?.(candidate.providerId) ?? null;
        if (driver && candidate.outboundFormat !== 'openai') {
          recordFor(candidate, wantsStream, false, 502, noTokens);
          if (more && groupId) {
            deps.routing?.onFailover(candidate.seat);
            logger.warn('proxy.failover', { path: rest, status: 502 });
            continue;
          }
          sendJson(res, 502, errorEnvelope(inbound, 'the provider is not served in this format'));
          return;
        }
        if (driver) {
          // Driver path always finishes the client response; no further failover.
          // Affinity / rotate advance only after a confirmed HTTP success (below).
          await serveDriver(driver, res, liveSpec, tf, outboundBody, wantsStream, rest, (s, ok, st, c) =>
            recordFor(candidate, s, ok, st, c),
          );
          return;
        }

        const apiKey = deps.getKey(candidate.providerId);
        const url =
          candidate.outboundFormat === 'gemini'
            ? geminiOutboundUrl(candidate.upstreamBaseUrl, candidate.modelId, wantsStream)
            : outboundUrl(candidate.outboundFormat, candidate.upstreamBaseUrl);
        const headers = {
          ...outboundHeaders(candidate.outboundFormat, apiKey),
          ...deps.getExtraHeaders?.(candidate.providerId, apiKey),
        };

        const send = (body: Record<string, unknown>) =>
          deps
            .fetchImpl(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal: controller.signal,
            })
            .catch(() => null);

        let upstream = await send(outboundBody);
        if (!upstream) {
          recordFor(candidate, wantsStream, false, 0, noTokens);
          lastFailure = { candidate, status: 0, retryAfter: null };
          if (more && shouldFailoverStatus(0)) {
            deps.routing?.onFailover(candidate.seat);
            logger.warn('proxy.failover', { path: rest, status: 0 });
            continue;
          }
          throw new Error(encodeIpcError('UPSTREAM_ERROR', 'could not reach the provider'));
        }

        if (upstream.status === 400 || upstream.status === 422) {
          const errorText = await upstream.text().catch(() => '');
          const fixed = autoFixRequest(
            candidate.outboundFormat,
            outboundBody,
            upstream.status,
            errorText,
          );
          if (fixed) {
            logger.info('proxy.auto_fix', { path: rest, status: upstream.status, code: fixed.fix });
            const retried = await send(fixed.body);
            if (!retried) {
              recordFor(candidate, wantsStream, false, 0, noTokens);
              lastFailure = { candidate, status: 0, retryAfter: null };
              if (more && shouldFailoverStatus(0)) {
                deps.routing?.onFailover(candidate.seat);
                continue;
              }
              throw new Error(encodeIpcError('UPSTREAM_ERROR', 'could not reach the provider'));
            }
            upstream = retried;
          } else {
            // Rebuild a Response-like shell so the failure path below still has status.
            // autoFix did not apply; the original body was already consumed — treat as final
            // for this seat (400/422 are not failover statuses).
            recordFor(candidate, wantsStream, false, upstream.status, noTokens);
            logger.warn('proxy.upstream', { path: rest, status: upstream.status });
            sendJson(res, 502, errorEnvelope(inbound, `the provider returned status ${upstream.status}`));
            return;
          }
        }

        if (!upstream.ok) {
          recordFor(candidate, wantsStream, false, upstream.status, noTokens);
          logger.warn('proxy.upstream', { path: rest, status: upstream.status });
          const retryAfter = safeRetryAfter(upstream.headers.get('retry-after'));
          lastFailure = { candidate, status: upstream.status, retryAfter };
          if (more && shouldFailoverStatus(upstream.status)) {
            deps.routing?.onFailover(candidate.seat);
            logger.warn('proxy.failover', { path: rest, status: upstream.status });
            continue;
          }
          if (upstream.status === 401 || upstream.status === 403) {
            sendJson(res, 401, errorEnvelope(inbound, 'the provider rejected the API key'));
            return;
          }
          if (PASSTHROUGH_STATUS.has(upstream.status)) {
            sendJson(
              res,
              upstream.status,
              errorEnvelope(
                inbound,
                upstream.status === 429 ? clientMessage(429) : 'the provider is overloaded',
              ),
              retryAfter ? { 'retry-after': retryAfter } : {},
            );
            return;
          }
          sendJson(res, 502, errorEnvelope(inbound, `the provider returned status ${upstream.status}`));
          return;
        }

        if (groupId) deps.routing?.onSuccess(groupId, conversationKey, candidate.seat);

        if (wantsStream) {
          const sniffer = createUsageSniffer(candidate.outboundFormat);
          await pipeStream(res, upstream.body, tf, candidate.modelId, rest, upstream.status, sniffer);
          recordFor(candidate, true, true, upstream.status, sniffer.result());
        } else {
          const text = await upstream.text();
          let upstreamJson: Record<string, unknown>;
          try {
            upstreamJson = JSON.parse(text) as Record<string, unknown>;
          } catch {
            throw new Error(
              encodeIpcError('UPSTREAM_ERROR', 'the provider returned an unreadable response'),
            );
          }
          const translated = tf.translateResponse(upstreamJson, candidate.modelId);
          recordFor(
            candidate,
            false,
            true,
            upstream.status,
            readResponseUsage(candidate.outboundFormat, upstreamJson),
          );
          logger.info('proxy.request', { path: rest, status: upstream.status, stream: false });
          sendJson(res, 200, translated);
        }
        return;
      }

      // Exhausted every candidate without an answer.
      if (lastFailure) {
        const { status, retryAfter } = lastFailure;
        if (status === 401 || status === 403) {
          sendJson(res, 401, errorEnvelope(inbound, 'the provider rejected the API key'));
          return;
        }
        if (PASSTHROUGH_STATUS.has(status)) {
          sendJson(
            res,
            status,
            errorEnvelope(inbound, status === 429 ? clientMessage(429) : 'the provider is overloaded'),
            retryAfter ? { 'retry-after': retryAfter } : {},
          );
          return;
        }
        if (status === 0) {
          throw new Error(encodeIpcError('UPSTREAM_ERROR', 'could not reach the provider'));
        }
        sendJson(res, 502, errorEnvelope(inbound, `the provider returned status ${status}`));
        return;
      }
      sendJson(res, 502, errorEnvelope(inbound, 'routing group has no reachable members'));
    } catch (err) {
      const { code, message } = decodeIpcError(err instanceof Error ? err.message : String(err));
      logger.warn('proxy.error', { path: rest, code });
      if (!res.headersSent) sendJson(res, statusForCode(code), errorEnvelope(inbound, message));
      else res.end();
    } finally {
      if (decision && trail.length > 0) {
        try {
          deps.routing?.recordDecision?.({
            groupId: decision.groupId,
            agentId: spec.agentId,
            strategy: decision.strategy,
            sticky: decision.sticky,
            attempts: trail,
            ok: trail[trail.length - 1]!.ok,
            ms: Date.now() - requestStart,
          });
        } catch {
          // status is best-effort; it can't fail a real request
        }
      }
    }
  }

  /**
   * Answer one request through an upstream driver. The body is already OpenAI Chat (the
   * route's outbound format); the driver's answer is produced as OpenAI Chat and run through
   * the route's response transforms. The upstream's own error text never reaches the client
   * and is never logged (status only).
   */
  async function serveDriver(
    driver: BoundUpstream,
    res: ServerResponse,
    spec: RouteSpec,
    tf: DirectionTransforms,
    body: Record<string, unknown>,
    wantsStream: boolean,
    path: string,
    record: (streamed: boolean, ok: boolean, status: number, counts: UsageCounts) => void,
  ): Promise<void> {
    const inbound = spec.inboundFormat;
    const noTokens = zeroUsage();
    const upstream = driver.driverId;
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    let result: Awaited<ReturnType<BoundUpstream['chat']>>;
    try {
      result = await driver.chat(body, controller.signal);
    } catch {
      result = { error: { status: 502, message: 'driver failure' } };
    }
    if ('error' in result) {
      const status = result.error.status;
      record(wantsStream, false, status, noTokens);
      logger.warn('proxy.upstream', { path, status, upstream });
      const clientStatus = status === 401 || status === 403 ? 401 : status === 429 || status === 400 ? status : 502;
      sendJson(res, clientStatus, errorEnvelope(inbound, clientMessage(status)));
      return;
    }
    const ident = newCompletionIdentity(typeof body.model === 'string' ? body.model : spec.modelId);
    if (!wantsStream) {
      const out = await collectCompletion(result.events, ident);
      if ('error' in out) {
        record(false, false, out.error.status, noTokens);
        logger.warn('proxy.upstream', { path, status: out.error.status, upstream });
        sendJson(res, 502, errorEnvelope(inbound, clientMessage(out.error.status)));
        return;
      }
      record(false, true, 200, readResponseUsage('openai', out.completion));
      logger.info('proxy.request', { path, status: 200, stream: false, upstream });
      sendJson(res, 200, tf.translateResponse(out.completion, spec.modelId));
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const sniffer = createUsageSniffer('openai');
    const transform = tf.makeStreamTransform(spec.modelId);
    const mapper = createChunkMapper(ident);
    let ok = true;
    let status = 200;
    const emit = async (events: SseEvent[]): Promise<void> => {
      for (const event of events) {
        sniffer.observe(event);
        for (const frame of transform(event)) await writeBackpressured(res, frame);
      }
    };
    try {
      for await (const e of result.events) {
        if ('error' in e) {
          // Mid-stream failure: end the answer as it stands; the client sees a cut-off.
          ok = false;
          status = e.error.status;
          break;
        }
        await emit(mapper.map(e));
      }
      if (ok) {
        await emit(mapper.done());
        for (const frame of transform.flush?.() ?? []) await writeBackpressured(res, frame);
      }
    } catch {
      ok = false;
    } finally {
      record(true, ok, status, sniffer.result());
      logger.info('proxy.request', { path, status, stream: true, upstream });
      res.end();
    }
  }

  async function pipeStream(
    res: ServerResponse,
    body: ReadableStream<Uint8Array> | null,
    tf: DirectionTransforms,
    modelId: string,
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
    const transform = tf.makeStreamTransform(modelId);
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
      for (const frame of transform.flush?.() ?? []) await writeBackpressured(res, frame);
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
