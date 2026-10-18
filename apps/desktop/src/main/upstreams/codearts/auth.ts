// CodeArts session source for the SnapEngine upstream driver.
//
// Reads the oauth token bundle (session JSON in `accessToken`), refreshes via
// STS when near expiry, and writes the renewed session back through the
// injected oauth manager. Nothing is logged.

import type { OAuthManager } from '../../oauth/oauthManager';
import { readOAuthTokens, writeOAuthTokens } from '../../oauth/oauthTokenStore';
import type { SecretStore } from '../../secrets/secretStore';
import {
  CODEARTS_REFRESH_LEAD_MS,
} from './constants';
import { refreshCodeArtsSession, type CodeArtsLoginFetch } from './login';
import {
  parseCodeArtsSession,
  serializeCodeArtsSession,
  sessionExpiresAtMs,
  type CodeArtsSession,
} from './session';

export type CodeArtsAuthFetch = CodeArtsLoginFetch;

export interface CodeArtsAuthDeps {
  secrets: SecretStore;
  oauth: Pick<OAuthManager, 'getAccessToken' | 'isConnected'>;
  fetchImpl: CodeArtsAuthFetch;
  now?: () => number;
}

export interface CodeArtsAuth {
  /** Fresh temporary credentials, or null when signed out / unreadable. */
  current(providerId: string, signal?: AbortSignal): Promise<CodeArtsSession | null>;
}

export function createCodeArtsAuth(deps: CodeArtsAuthDeps): CodeArtsAuth {
  const now = deps.now ?? Date.now;
  const renewing = new Map<string, Promise<CodeArtsSession | null>>();

  async function renew(providerId: string, session: CodeArtsSession): Promise<CodeArtsSession | null> {
    try {
      const next = await refreshCodeArtsSession(session, deps.fetchImpl);
      const tokens = {
        accessToken: serializeCodeArtsSession(next),
        expiresAt: sessionExpiresAtMs(next),
        ...(next.refreshToken ? { refreshToken: next.refreshToken } : {}),
      };
      writeOAuthTokens(deps.secrets, providerId, tokens);
      return next;
    } catch {
      return null;
    }
  }

  return {
    async current(providerId, _signal) {
      if (!deps.oauth.isConnected(providerId)) return null;
      // Prefer a manager-side refresh (also updates account status), then fall back
      // to reading the stored session for the driver-local early window.
      const access = await deps.oauth.getAccessToken(providerId);
      let session = parseCodeArtsSession(access);
      if (!session) {
        const bundle = readOAuthTokens(deps.secrets, providerId);
        session = parseCodeArtsSession(bundle?.accessToken);
      }
      if (!session) return null;

      const expires = sessionExpiresAtMs(session);
      const t = now();
      const stale = expires !== null && t >= expires - CODEARTS_REFRESH_LEAD_MS;
      if (!stale || !session.refreshToken) return session;

      let p = renewing.get(providerId);
      if (!p) {
        p = renew(providerId, session).finally(() => renewing.delete(providerId));
        renewing.set(providerId, p);
      }
      const next = await p;
      return next ?? session;
    },
  };
}
