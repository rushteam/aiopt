import type { OAuthProviderConfig, OAuthSubscriptionKind } from '../../../shared/oauthProviders';
import type { OAuthTokenBundle } from '../oauthTokenStore';

export interface OAuthDriverContext {
  config: OAuthProviderConfig;
  redirectUri: string;
  state: string;
  pkceChallenge: string;
}

export interface OAuthTokenExchangeInput {
  config: OAuthProviderConfig;
  redirectUri: string;
  code: string;
  pkceVerifier: string;
}

export interface OAuthRefreshInput {
  config: OAuthProviderConfig;
  refreshToken: string;
}

export interface OAuthDriver {
  kind: OAuthSubscriptionKind;
  buildAuthorizeUrl(ctx: OAuthDriverContext): string;
  exchangeCode(input: OAuthTokenExchangeInput, fetchImpl: OAuthFetch): Promise<OAuthTokenBundle>;
  refresh?(input: OAuthRefreshInput, fetchImpl: OAuthFetch): Promise<OAuthTokenBundle>;
}

export type OAuthFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
