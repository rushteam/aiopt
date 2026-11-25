// ChatGPT subscription (Codex) OAuth driver — authorization code + PKCE on the Codex CLI's
// registered loopback redirect (`http://localhost:1455/auth/callback`).
//
// Uses the Codex CLI's public client id (no secret). The access token is a JWT whose
// `https://api.openai.com/auth`.chatgpt_account_id claim the proxy sends as
// `chatgpt-account-id` (proxy/subscriptionWire.ts). See oauth-providers.md for the ToS note.

import { throwIpcError } from '../../ipc/validate';
import { decodeJwtPayload } from '../../agentImport/jwtPayload';
import { generateOAuthState, generatePkce } from '../pkce';
import { browserAuthorize, formBody, postTokenRequest } from './subscriptionCommon';
import type { OAuthDriver } from './types';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_CALLBACK_PORT = 1455;
const SCOPE = 'openid profile email offline_access';

/** The ChatGPT account id carried in a Codex access token, or null. */
export function codexAccountId(accessToken: string): string | null {
  const auth = decodeJwtPayload(accessToken)?.['https://api.openai.com/auth'];
  if (!auth || typeof auth !== 'object') return null;
  const id = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** A display label (email) from the id token, when the server returned one. */
function emailFrom(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string') return undefined;
  const email = decodeJwtPayload(idToken)?.email;
  return typeof email === 'string' && email !== '' ? email : undefined;
}

export function buildCodexAuthorizeUrl(redirectUri: string, state: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'aiopt');
  return url.toString();
}

export const openaiCodexDriver: OAuthDriver = {
  kind: 'openai_codex',

  buildAuthorizeUrl() {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'ChatGPT OAuth uses the custom login path');
  },

  async exchangeCode() {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'ChatGPT OAuth uses the custom login path');
  },

  async runLogin(deps) {
    const { verifier, challenge } = generatePkce();
    const state = generateOAuthState();
    const { code, redirectUri } = await browserAuthorize(
      deps.openExternal,
      { port: CODEX_CALLBACK_PORT, path: '/auth/callback', redirectHost: 'localhost' },
      (uri) => buildCodexAuthorizeUrl(uri, state, challenge),
      state,
    );
    const { bundle, raw } = await postTokenRequest(
      deps.fetchImpl,
      TOKEN_URL,
      formBody({
        grant_type: 'authorization_code',
        client_id: CODEX_CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
      'form',
      { code: 'UNAUTHORIZED', message: 'ChatGPT sign-in was rejected' },
    );
    if (!bundle.refreshToken) throwIpcError('UPSTREAM_ERROR', 'ChatGPT sign-in returned no refresh token');
    if (!codexAccountId(bundle.accessToken)) {
      throwIpcError('PRECONDITION_FAILED', 'this ChatGPT account has no Codex workspace');
    }
    return { tokens: bundle, accountLabel: emailFrom(raw.id_token) };
  },

  async refresh(input, fetchImpl) {
    const { bundle } = await postTokenRequest(
      fetchImpl,
      TOKEN_URL,
      formBody({ grant_type: 'refresh_token', refresh_token: input.refreshToken, client_id: CODEX_CLIENT_ID }),
      'form',
      { code: 'UNAUTHORIZED', message: 'ChatGPT token refresh failed' },
    );
    // OpenAI rotates refresh tokens; keep the old one only if a reply omits it.
    if (!bundle.refreshToken) bundle.refreshToken = input.refreshToken;
    return bundle;
  },
};
