// Pure route table + token logic for the translation proxy.
//
// The proxy runs ONE http.Server on one ephemeral port. Each cross-format binding is
// addressed by a per-binding path token: the agent's config points at
// `http://127.0.0.1:<port>/<token>` and appends its native suffix (claude →
// `/v1/messages`). The server strips the leading token segment, looks the route up
// here, and the route's spec — not any sniffing of the body — decides the translation
// direction. Tokens are minted per binding and rotate on every re-register, so an old
// token dies the instant a binding is re-pointed, cleared, or the app restarts.
//
// No Node http, no Electron: fully unit-testable. The one impure dependency is
// `randomUUID` (same primitive providerStore already uses to mint ids) and the coded
// error helper. `resolve()` returning undefined is the caller's cue to emit a 401.

import { randomUUID } from 'node:crypto';
import type { AgentId, ApiFormat } from '../../shared/aiProviders';
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

  /** Register (or rotate) the route for a binding; returns the fresh token. */
  register(spec: RouteSpec): string {
    // Rotate: drop any previous token for this agent so it dies immediately.
    const prev = this.tokenByAgent.get(spec.agentId);
    if (prev !== undefined) this.byToken.delete(prev);
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

  /** Remove every route (e.g. proxy stop). */
  clear(): void {
    this.byToken.clear();
    this.tokenByAgent.clear();
  }
}

/**
 * Assert the inbound request path matches the route's declared inbound format. The
 * token already fixed the binding identity; this guards a client hitting the wrong
 * native suffix (e.g. an anthropic route receiving something other than /v1/messages).
 * Throws a coded error rather than guessing.
 */
export function assertInboundPath(spec: RouteSpec, rest: string): void {
  const expected = INBOUND_PATH[spec.inboundFormat];
  // Compare the path prefix so trailing slashes / query already stripped upstream.
  const restPath = rest.split('?')[0] ?? '';
  // Responses clients may or may not prefix `/v1` before `/responses`; accept both.
  const ok =
    expected !== '' &&
    (restPath.startsWith(expected) ||
      (spec.inboundFormat === 'openai-responses' && restPath.startsWith(`/v1${expected}`)));
  if (!ok) {
    throwIpcError(
      'INVALID_PARAMS',
      `inbound path "${restPath}" does not match the ${spec.inboundFormat} format for this binding`,
    );
  }
}
