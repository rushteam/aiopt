// Wire adaptations for subscription-backed upstreams (ChatGPT / Claude / Copilot sign-ins).
//
// A subscription token is not an API key: each vendor's subscription backend only accepts
// it with the identity, auth scheme, URL shape and body fields its own CLI / editor client
// sends. The proxy applies these main-side at request time (tokens never leave main). The
// adaptation is keyed by how the provider authenticates — a built-in OAuth kind, or an
// imported agent sign-in carrying the same token type — never by base URL alone.
//
// Known limits (documented in docs/dev-rules/oauth-providers.md):
//  - Codex: the ChatGPT backend only streams; a non-streaming client request is rejected
//    upstream (every bindable agent streams).
//  - Claude: Claude Code's tool-name casing ("stealth" renaming) is not applied.

import type { ApiFormat } from '../../shared/aiProviders';
import type { AgentImportAgentId } from '../../shared/agentImport';
import {
  providerUsesAgentImport,
  providerUsesOAuth,
  type OAuthSubscriptionKind,
  type ProviderCredentialMode,
} from '../../shared/oauthProviders';
import { codexAccountId } from '../oauth/drivers/openaiCodex';
import { copilotBaseFromToken, COPILOT_EDITOR_HEADERS } from '../oauth/drivers/githubCopilot';

export type SubscriptionWire = 'codex' | 'claude' | 'copilot';

export interface SubscriptionWireProvider {
  credentialMode?: ProviderCredentialMode;
  oauth?: { kind: OAuthSubscriptionKind };
  agentImport?: { agentId: AgentImportAgentId };
}

const CLAUDE_CODE_VERSION = '2.1.322';
const CLAUDE_OAUTH_BETAS = ['claude-code-20250219', 'oauth-2025-04-20'];
/** Claude's subscription backend requires Claude Code's identity as the first system block. */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const CODEX_DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

export function subscriptionWireFor(provider: SubscriptionWireProvider | null | undefined): SubscriptionWire | null {
  if (!provider) return null;
  if (providerUsesOAuth(provider.credentialMode)) {
    switch (provider.oauth?.kind) {
      case 'openai_codex':
        return 'codex';
      case 'anthropic_claude':
        return 'claude';
      case 'github_copilot':
        return 'copilot';
      default:
        return null;
    }
  }
  // Imported Codex / Claude sign-ins carry the same token types. (An imported Copilot
  // sign-in is a GitHub token, not a Copilot API token, so it keeps the plain path.)
  if (providerUsesAgentImport(provider.credentialMode)) {
    if (provider.agentImport?.agentId === 'codex') return 'codex';
    if (provider.agentImport?.agentId === 'claude') return 'claude';
  }
  return null;
}

export interface WireRequest {
  /** The URL outboundUrl() built. */
  url: string;
  /** Outbound headers; mutated in place. */
  headers: Record<string, string>;
  /** Outbound JSON body; mutated in place. */
  body: Record<string, unknown>;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Merge a comma-separated header value without duplicates. */
function mergeList(existing: string | undefined, add: readonly string[]): string {
  const items = (existing ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const a of add) if (!items.includes(a)) items.push(a);
  return items.join(',');
}

function prependClaudeIdentity(body: Record<string, unknown>): void {
  const identity = { type: 'text', text: CLAUDE_CODE_IDENTITY };
  const system = body.system;
  if (typeof system === 'string') {
    if (system.startsWith(CLAUDE_CODE_IDENTITY)) return;
    body.system = system === '' ? [identity] : [identity, { type: 'text', text: system }];
    return;
  }
  if (Array.isArray(system)) {
    const first = system[0] as { text?: unknown } | undefined;
    if (typeof first?.text === 'string' && first.text.startsWith(CLAUDE_CODE_IDENTITY)) return;
    body.system = [identity, ...system];
    return;
  }
  body.system = [identity];
}

/**
 * Adapt one outbound request for a subscription wire. Returns the URL to call (possibly
 * rewritten); headers and body are adjusted in place. A format the wire does not apply to
 * (e.g. a Claude sign-in routed through some other dialect) passes through unchanged.
 */
export function adaptSubscriptionRequest(
  wire: SubscriptionWire,
  format: ApiFormat,
  baseUrl: string,
  apiKey: string | null,
  req: WireRequest,
): string {
  switch (wire) {
    case 'codex': {
      if (format !== 'openai-responses') return req.url;
      const accountId = apiKey ? codexAccountId(apiKey) : null;
      if (accountId) req.headers['chatgpt-account-id'] = accountId;
      req.headers.originator = 'aiopt';
      req.headers['OpenAI-Beta'] = 'responses=experimental';
      if (req.body.stream === true) req.headers.accept = 'text/event-stream';
      // The ChatGPT backend keeps nothing server-side and requires instructions.
      req.body.store = false;
      if (typeof req.body.instructions !== 'string' || req.body.instructions === '') {
        req.body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
      }
      // `…/backend-api/codex` + `/responses` (outboundUrl would insert a /v1).
      const base = trimBase(baseUrl);
      return base.endsWith('/responses') ? base : `${base}/responses`;
    }
    case 'claude': {
      if (format !== 'anthropic') return req.url;
      // Subscription tokens authenticate as Bearer, never as an API key.
      delete req.headers['x-api-key'];
      if (apiKey) req.headers.authorization = `Bearer ${apiKey}`;
      req.headers['anthropic-beta'] = mergeList(req.headers['anthropic-beta'], CLAUDE_OAUTH_BETAS);
      req.headers['user-agent'] = `claude-cli/${CLAUDE_CODE_VERSION}`;
      req.headers['x-app'] = 'cli';
      prependClaudeIdentity(req.body);
      return req.url;
    }
    case 'copilot': {
      if (format !== 'openai') return req.url;
      Object.assign(req.headers, COPILOT_EDITOR_HEADERS);
      req.headers['Openai-Intent'] = 'conversation-edits';
      req.headers['X-Initiator'] = 'user';
      // The token names the API host it is bound to; Copilot has no /v1 prefix.
      const base = (apiKey && copilotBaseFromToken(apiKey)) || trimBase(baseUrl);
      return `${base}/chat/completions`;
    }
  }
}
