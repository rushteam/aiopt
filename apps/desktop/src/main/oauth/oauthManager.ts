// OAuth provider sessions — main-only token lifecycle for subscription providers.

import type { Provider } from '../../shared/aiProviders';
import {
  isOAuthSubscriptionKind,
  providerUsesOAuth,
  type OAuthProviderStatus,
  type OAuthSubscriptionKind,
} from '../../shared/oauthProviders';
import { throwIpcError } from '../ipc/validate';
import { openExternalUrl } from '../security/navigation';
import type { SecretStore } from '../secrets/secretStore';
import type { ProviderStore } from '../providers/providerStore';
import { generateOAuthState, generatePkce } from './pkce';
import { startOAuthCallbackServer } from './callbackServer';
import { clearOAuthTokens, readOAuthTokens, writeOAuthTokens } from './oauthTokenStore';
import { getOAuthDriver } from './drivers/registry';
import type { OAuthFetch } from './drivers/types';
import { logger } from '../logger';

const log = logger.child('oauth');

const REFRESH_SKEW_MS = 60_000;

export interface OAuthManager {
  getStatus(providerId: string): OAuthProviderStatus;
  isConnected(providerId: string): boolean;
  /** Sync read of the stored access token (no refresh) — for the proxy hot path. */
  readAccessTokenSync(providerId: string): string | null;
  /** Plaintext access token with refresh when near expiry — main-only. */
  getAccessToken(providerId: string): Promise<string | null>;
  startLogin(providerId: string): Promise<void>;
  disconnect(providerId: string): void;
}

interface PendingFlow {
  providerId: string;
  state: string;
  verifier: string;
}

export function createOAuthManager(deps: {
  store: ProviderStore;
  secrets: SecretStore;
  fetchImpl: OAuthFetch;
  onProvidersChanged: () => void;
}): OAuthManager {
  let pending: PendingFlow | null = null;

  function requireOAuthProvider(providerId: string): Provider {
    const provider = deps.store.getProvider(providerId);
    if (!provider) throwIpcError('NOT_FOUND', 'provider not found');
    if (!providerUsesOAuth(provider.credentialMode) || !provider.oauth) {
      throwIpcError('PRECONDITION_FAILED', 'provider is not OAuth-backed');
    }
    if (!isOAuthSubscriptionKind(provider.oauth.kind)) {
      throwIpcError('INVALID_PARAMS', 'unknown OAuth kind');
    }
    return provider;
  }

  function driverFor(provider: Provider) {
    return getOAuthDriver(provider.oauth!.kind as OAuthSubscriptionKind);
  }

  function getStatus(providerId: string): OAuthProviderStatus {
    const provider = deps.store.getProvider(providerId);
    if (!provider?.oauth) {
      return { connected: false, accountLabel: null, expiresAt: null };
    }
    const tokens = readOAuthTokens(deps.secrets, providerId);
    return {
      connected: tokens !== null,
      accountLabel: provider.oauth.accountLabel ?? null,
      expiresAt: tokens?.expiresAt ?? null,
    };
  }

  function isConnected(providerId: string): boolean {
    return readOAuthTokens(deps.secrets, providerId) !== null;
  }

  async function refreshIfNeeded(provider: Provider, bundle: NonNullable<ReturnType<typeof readOAuthTokens>>) {
    if (!bundle.expiresAt || bundle.expiresAt > Date.now() + REFRESH_SKEW_MS) return bundle;
    if (!bundle.refreshToken) return bundle;
    const driver = driverFor(provider);
    if (!driver.refresh) return bundle;
    const next = await driver.refresh(
      { config: provider.oauth!, refreshToken: bundle.refreshToken },
      deps.fetchImpl,
    );
    writeOAuthTokens(deps.secrets, provider.id, next);
    return next;
  }

  function readAccessTokenSync(providerId: string): string | null {
    return readOAuthTokens(deps.secrets, providerId)?.accessToken ?? null;
  }

  async function getAccessToken(providerId: string): Promise<string | null> {
    const provider = deps.store.getProvider(providerId);
    if (!provider || !providerUsesOAuth(provider.credentialMode)) return null;
    let bundle = readOAuthTokens(deps.secrets, providerId);
    if (!bundle) return null;
    try {
      bundle = await refreshIfNeeded(provider, bundle);
    } catch (err) {
      log.warn('oauth.refresh_failed', {
        code: err instanceof Error ? err.message.match(/^\[([A-Z_]+)\]/)?.[1] : undefined,
      });
      return null;
    }
    return bundle.accessToken;
  }

  async function startLogin(providerId: string): Promise<void> {
    if (pending) throwIpcError('PRECONDITION_FAILED', 'another OAuth login is already in progress');
    const provider = requireOAuthProvider(providerId);
    const driver = driverFor(provider);
    const { verifier, challenge } = generatePkce();
    const state = generateOAuthState();
    pending = { providerId, state, verifier };

    const server = await startOAuthCallbackServer();
    try {
      const authorizeUrl = driver.buildAuthorizeUrl({
        config: provider.oauth!,
        redirectUri: server.redirectUri,
        state,
        pkceChallenge: challenge,
      });
      const opened = await openExternalUrl(authorizeUrl);
      if (!opened) throwIpcError('PRECONDITION_FAILED', 'could not open the system browser');

      const callback = await server.result;
      if (callback.state !== state) throwIpcError('UNAUTHORIZED', 'OAuth state mismatch');
      if (callback.error || !callback.code) {
        throwIpcError('PRECONDITION_FAILED', 'OAuth login was cancelled or failed');
      }

      const tokens = await driver.exchangeCode(
        {
          config: provider.oauth!,
          redirectUri: server.redirectUri,
          code: callback.code,
          pkceVerifier: verifier,
        },
        deps.fetchImpl,
      );
      writeOAuthTokens(deps.secrets, providerId, tokens);

      const updated: Provider = {
        ...provider,
        oauth: { ...provider.oauth!, accountLabel: provider.oauth!.accountLabel ?? 'Connected' },
      };
      deps.store.replaceProvider(updated);
      deps.onProvidersChanged();
      log.info('oauth.connected', { provider: providerId });
    } finally {
      pending = null;
      server.close();
    }
  }

  function disconnect(providerId: string): void {
    clearOAuthTokens(deps.secrets, providerId);
    const provider = deps.store.getProvider(providerId);
    if (provider?.oauth) {
      deps.store.replaceProvider({
        ...provider,
        oauth: { ...provider.oauth, accountLabel: undefined },
      });
    }
    deps.onProvidersChanged();
    log.info('oauth.disconnected', { provider: providerId });
  }

  return { getStatus, isConnected, readAccessTokenSync, getAccessToken, startLogin, disconnect };
}
