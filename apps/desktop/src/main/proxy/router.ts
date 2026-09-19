// Pure route table + token logic for the translation proxy.
//
// The proxy runs ONE http.Server on a fixed loopback port. Each binding is addressed by
// a per-binding path token: the agent's config points at `http://127.0.0.1:<port>/<token>`
// and appends its native suffix (claude → `/v1/messages`). The server strips the leading
// token segment, looks the route up here, and the route's spec — not any sniffing of the
// body — decides the translation direction. A token is STABLE for as long as its binding
// points at the same target: `register` REUSES the existing token when the new spec is
// identical to the live one, and only mints a fresh one (rotating away the old) when the
// binding is re-pointed to a different provider/model/format. It dies when the binding is
// cleared or its provider removed. The port + tokens are persisted (see proxyStore.ts) so a
// restart rehydrates the same identity a running agent already cached, rather than 401ing
// it — that persistence is orchestrated by translationProxy; this table stays pure.
//
// No Node http, no Electron: fully unit-testable. The one impure dependency is
// `randomUUID` (same primitive providerStore already uses to mint ids) and the coded
// error helper. `resolve()` returning undefined is the caller's cue to emit a 401.

import { randomUUID } from 'node:crypto';
import type { AgentId, ApiFormat } from '../../shared/aiProviders';
import type { PersistedRoute } from './proxyStore';
import { throwIpcError } from '../ipc/validate';

/** One cross-format route: which binding, which direction, and where to forward. */
export interface RouteSpec {
  /** The bound agent — the binding key; one live route per agent, rotated on re-register. */
  agentId: AgentId;
  providerId: string;
  /** Format the agent speaks (what arrives at the proxy). */
  inboundFormat: ApiFormat;
  /** Format the provider speaks (what we forward upstream). */
  outboundFormat: ApiFormat;
  /** The real provider base URL (never surfaced to the agent). */
  upstreamBaseUrl: string;
  /** The wire model id to force onto the upstream request. */
  modelId: string;
}

/** The native inbound path each translatable format's client appends after the token. */
export const INBOUND_PATH: Record<ApiFormat, string> = {
  anthropic: '/v1/messages',
  openai: '/v1/chat/completions',
  // Responses clients (codex/grok) POST to `/responses`; some SDKs prefix `/v1`.
  // assertInboundPath tolerates the optional `/v1` for this format.
  'openai-responses': '/responses',
  gemini: '', // not translatable; never routed
};

/** Split `/<token>/rest…` into its token segment and the remaining suffix path. */
export function parseTokenFromPath(pathname: string): { token: string; rest: string } {
  // Drop any query string and the leading slash, then take the first segment.
  const path = pathname.split('?')[0] ?? '';
  const trimmed = path.replace(/^\/+/, '');
  const slash = trimmed.indexOf('/');
  if (slash === -1) return { token: trimmed, rest: '/' };
  return { token: trimmed.slice(0, slash), rest: trimmed.slice(slash) };
}

/**
 * Pure route registry. Keyed for lookup by token (incoming requests) and indexed by
 * agent id (so a binding change can rotate or drop its route). Not thread-shared —
 * lives inside the single main-process proxy instance.
 */
export class ProxyRouter {
  private byToken = new Map<string, RouteSpec>();
  private tokenByAgent = new Map<AgentId, string>();

  /**
   * Rebuild the table from persisted routes (see proxyStore.ts). Skips a duplicate token
   * or a second route for the same agent — the persistence layer already dedupes, so this
   * is only a defensive floor keeping the one-token-per-agent invariant.
   */
  constructor(initial?: PersistedRoute[]) {
    if (!initial) return;
    for (const { token, spec } of initial) {
      if (this.byToken.has(token) || this.tokenByAgent.has(spec.agentId)) continue;
      this.byToken.set(token, spec);
      this.tokenByAgent.set(spec.agentId, token);
    }
  }

  /**
   * Register the route for a binding; returns the token to write into the agent's config.
   * REUSES the existing token when the new spec is identical to the live one (so a restart's
   * idempotent replay, or a no-op rebind, keeps the address the agent already cached). Mints
   * a fresh token — rotating the old one away — only when the binding's target actually
   * changed (different provider/model/format/upstream).
   */
  register(spec: RouteSpec): string {
    const prev = this.tokenByAgent.get(spec.agentId);
    if (prev !== undefined) {
      const prevSpec = this.byToken.get(prev);
      if (prevSpec && sameSpec(prevSpec, spec)) {
        // Same target: keep the token, refresh the stored spec (identical, but keep the
        // map authoritative) and hand back the address the agent already holds.
        this.byToken.set(prev, spec);
        return prev;
      }
      // Re-pointed: drop the old token so it dies immediately.
      this.byToken.delete(prev);
    }
    const token = randomUUID();
    this.byToken.set(token, spec);
    this.tokenByAgent.set(spec.agentId, token);
    return token;
  }

  /** Drop the route for an agent (binding cleared / restored / provider removed). */
  unregister(agentId: AgentId): void {
    const token = this.tokenByAgent.get(agentId);
    if (token !== undefined) this.byToken.delete(token);
    this.tokenByAgent.delete(agentId);
  }

  /** Look up a route by its token; undefined → the server should answer 401. */
  resolve(token: string): RouteSpec | undefined {
    return token === '' ? undefined : this.byToken.get(token);
  }

  /** Whether a live route exists for this agent. */
  has(agentId: AgentId): boolean {
    return this.tokenByAgent.has(agentId);
  }

  /** The live token+spec for an agent, or undefined when it has no route. */
  routeFor(agentId: AgentId): PersistedRoute | undefined {
    const token = this.tokenByAgent.get(agentId);
    if (token === undefined) return undefined;
    const spec = this.byToken.get(token);
    return spec ? { token, spec } : undefined;
  }

  /** Every live route (token+spec), for persisting the proxy identity. */
  snapshot(): PersistedRoute[] {
    const out: PersistedRoute[] = [];
    for (const [agentId, token] of this.tokenByAgent) {
      const spec = this.byToken.get(token);
      if (spec) out.push({ token, spec });
      else void agentId; // token/agent maps drifted — skip (should never happen)
    }
    return out;
  }

  /** Drop every route from MEMORY (e.g. proxy stop). Does not touch persistence. */
  clear(): void {
    this.byToken.clear();
    this.tokenByAgent.clear();
  }
}

/** Whether two specs point at the same target (so a re-register can keep the token). */
function sameSpec(a: RouteSpec, b: RouteSpec): boolean {
  return (
    a.providerId === b.providerId &&
    a.inboundFormat === b.inboundFormat &&
    a.outboundFormat === b.outboundFormat &&
    a.upstreamBaseUrl === b.upstreamBaseUrl &&
    a.modelId === b.modelId
  );
}

/**
 * Assert the inbound request path matches the route's declared inbound format. The
 * token already fixed the binding identity; this guards a client hitting the wrong
 * native suffix (e.g. an anthropic route receiving something other than /v1/messages).
 * Throws a coded error rather than guessing.
 *
 * Clients disagree on the `/v1` version segment: some SDKs already prefix it before the
 * native suffix, others treat the whole loopback base URL as the API root and POST the
 * bare endpoint (pi's openai-completions adapter sends `/chat/completions`, not
 * `/v1/chat/completions`). Since the outbound URL is rebuilt independently
 * (see `outboundUrl`) and never derived from this suffix, we accept the endpoint with OR
 * without a leading `/v1` for every format — the version segment carries no routing
 * meaning here, only the endpoint does.
 */
export function assertInboundPath(spec: RouteSpec, rest: string): void {
  const expected = INBOUND_PATH[spec.inboundFormat];
  // Compare the path prefix so trailing slashes / query already stripped upstream.
  const restPath = rest.split('?')[0] ?? '';
  // The native suffix already carries its own `/v1` (e.g. `/v1/messages`); also accept the
  // bare endpoint with the version segment stripped, and the endpoint re-prefixed with `/v1`.
  const bare = expected.replace(/^\/v1(?=\/)/, '');
  const ok =
    expected !== '' &&
    (restPath.startsWith(expected) ||
      restPath.startsWith(bare) ||
      restPath.startsWith(`/v1${bare}`));
  if (!ok) {
    throwIpcError(
      'INVALID_PARAMS',
      `inbound path "${restPath}" does not match the ${spec.inboundFormat} format for this binding`,
    );
  }
}
