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
  /** Current access-token field — drivers that embed a session JSON (e.g. CodeArts) need it. */
  accessToken?: string;
}

export interface OAuthCustomLoginResult {
  tokens: OAuthTokenBundle;
  accountLabel?: string;
}

export interface OAuthDeviceCodePrompt {
  userCode: string;
  verificationUri: string;
}

export interface OAuthCustomLoginDeps {
  fetchImpl: OAuthFetch;
  openExternal: (url: string) => Promise<boolean>;
  /**
   * Device-code flows: show the user code in a main-owned native dialog (never the
   * renderer). Resolves false when the user cancels. Absent = device flows unavailable.
   */
  showDeviceCode?: (prompt: OAuthDeviceCodePrompt) => Promise<boolean>;
  /** Poll delay; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface OAuthDriver {
  kind: OAuthSubscriptionKind;
  buildAuthorizeUrl(ctx: OAuthDriverContext): string;
  exchangeCode(input: OAuthTokenExchangeInput, fetchImpl: OAuthFetch): Promise<OAuthTokenBundle>;
  refresh?(input: OAuthRefreshInput, fetchImpl: OAuthFetch): Promise<OAuthTokenBundle>;
  /**
   * When set, the manager delegates the whole browser login to the driver
   * (loopback port / PKCE / DPoP / portal quirks). `buildAuthorizeUrl` / `exchangeCode`
   * are unused for that path but still required for the interface.
   */
  runLogin?(deps: OAuthCustomLoginDeps): Promise<OAuthCustomLoginResult>;
}

export type OAuthFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
