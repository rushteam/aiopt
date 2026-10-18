// Huawei CodeArts (码道) OAuth driver — portal + STS PKCE/DPoP.
//
// Login is entirely custom (`runLogin`): the manager opens the portal URL and
// stores the resulting session JSON as the oauth access token. Refresh reuses
// the embedded code_verifier + DPoP private key.

import { throwIpcError } from '../../ipc/validate';
import {
  refreshCodeArtsSession,
  startCodeArtsOAuthFlow,
  type CodeArtsLoginFetch,
} from '../../upstreams/codearts/login';
import {
  parseCodeArtsSession,
  serializeCodeArtsSession,
  sessionAccountLabel,
  sessionExpiresAtMs,
} from '../../upstreams/codearts/session';
import type { OAuthTokenBundle } from '../oauthTokenStore';
import type { OAuthDriver, OAuthFetch, OAuthRefreshInput } from './types';

function asLoginFetch(fetchImpl: OAuthFetch): CodeArtsLoginFetch {
  return (url, init) => fetchImpl(url, init);
}

export const huaweiCodeartsDriver: OAuthDriver = {
  kind: 'huawei_codearts',

  buildAuthorizeUrl() {
    // Unused when runLogin is present; kept so the interface stays uniform.
    throwIpcError('UNSUPPORTED_CAPABILITY', 'CodeArts OAuth uses the custom login path');
  },

  async exchangeCode() {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'CodeArts OAuth uses the custom login path');
  },

  async runLogin(deps) {
    const flow = await startCodeArtsOAuthFlow(asLoginFetch(deps.fetchImpl));
    try {
      const opened = await deps.openExternal(flow.authorizeUrl);
      if (!opened) throwIpcError('PRECONDITION_FAILED', 'could not open the system browser');
      const outcome = await flow.result;
      const tokens: OAuthTokenBundle = {
        accessToken: outcome.accessToken,
        expiresAt: outcome.expiresAt,
      };
      if (outcome.refreshToken) tokens.refreshToken = outcome.refreshToken;
      return { tokens, accountLabel: outcome.accountLabel };
    } finally {
      flow.close();
    }
  },

  async refresh(input: OAuthRefreshInput, fetchImpl) {
    const session = parseCodeArtsSession(input.accessToken);
    if (!session) throwIpcError('UNAUTHORIZED', 'CodeArts session missing or corrupt');
    // Prefer the refresh token embedded in the session; the bundle field is a mirror.
    if (input.refreshToken && !session.refreshToken) session.refreshToken = input.refreshToken;
    let next;
    try {
      next = await refreshCodeArtsSession(session, asLoginFetch(fetchImpl));
    } catch {
      throwIpcError('UNAUTHORIZED', 'CodeArts token refresh failed');
    }
    const tokens: OAuthTokenBundle = {
      accessToken: serializeCodeArtsSession(next),
      expiresAt: sessionExpiresAtMs(next),
    };
    if (next.refreshToken) tokens.refreshToken = next.refreshToken;
    // accountLabel is updated by the manager only on login; keep identity fields in session.
    void sessionAccountLabel(next);
    return tokens;
  },
};
