// OAuth subscription providers — shared types only (no I/O).

/** How the provider authenticates to upstream. */
export type ProviderCredentialMode = 'api_key' | 'oauth';

/**
 * Built-in OAuth driver ids. `generic_pkce` is user-configured; subscription kinds use
 * fixed driver metadata when enabled.
 */
export const OAUTH_SUBSCRIPTION_KINDS = [
  'generic_pkce',
  'openai_codex',
  'anthropic_claude',
  'github_copilot',
] as const;

export type OAuthSubscriptionKind = (typeof OAUTH_SUBSCRIPTION_KINDS)[number];

/** Public OAuth configuration persisted on the provider (no secrets). */
export interface OAuthProviderConfig {
  kind: OAuthSubscriptionKind;
  /** OAuth public client id. */
  clientId?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  /** Shown in UI after a successful login (email or account name). */
  accountLabel?: string;
}

/** Safe OAuth status returned over IPC / in ProviderSummary. */
export interface OAuthProviderStatus {
  connected: boolean;
  accountLabel: string | null;
  /** Epoch ms when the access token expires, or null if unknown. */
  expiresAt: number | null;
}

export function isOAuthSubscriptionKind(value: unknown): value is OAuthSubscriptionKind {
  return typeof value === 'string' && (OAUTH_SUBSCRIPTION_KINDS as readonly string[]).includes(value);
}

export function providerUsesOAuth(
  credentialMode: ProviderCredentialMode | undefined,
): boolean {
  return credentialMode === 'oauth';
}
