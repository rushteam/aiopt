// Claude subscription (Pro / Max) OAuth driver — authorization code + PKCE on a loopback
// redirect, with JSON token requests (Claude Code's flow).
//
// Uses Claude Code's public client id. The resulting `sk-ant-oat…` token only works with
// Bearer auth plus the OAuth beta header and Claude Code identity the proxy adds
// (proxy/subscriptionWire.ts). See oauth-providers.md for the ToS note.

import { throwIpcError } from '../../ipc/validate';
import { generateOAuthState, generatePkce } from '../pkce';
import { browserAuthorize, postTokenRequest } from './subscriptionCommon';
import type { OAuthDriver } from './types';

export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** Preferred port; Anthropic accepts any loopback port, so a busy one falls back to ephemeral. */
export const CLAUDE_CALLBACK_PORT = 53692;
const SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

export function buildClaudeAuthorizeUrl(redirectUri: string, state: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLAUDE_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

function accountLabelFrom(raw: Record<string, unknown>): string | undefined {
  const account = raw.account;
  if (!account || typeof account !== 'object') return undefined;
  const email = (account as Record<string, unknown>).email_address;
  return typeof email === 'string' && email !== '' ? email : undefined;
}

export const anthropicClaudeDriver: OAuthDriver = {
  kind: 'anthropic_claude',

  buildAuthorizeUrl() {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Claude OAuth uses the custom login path');
  },

  async exchangeCode() {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Claude OAuth uses the custom login path');
  },

  async runLogin(deps) {
    const { verifier, challenge } = generatePkce();
    const state = generateOAuthState();
    const build = (uri: string) => buildClaudeAuthorizeUrl(uri, state, challenge);
    const result = await browserAuthorize(
      deps.openExternal,
      { port: CLAUDE_CALLBACK_PORT, path: '/callback', redirectHost: 'localhost', fallbackToEphemeral: true },
      build,
      state,
    );
    const { bundle, raw } = await postTokenRequest(
      deps.fetchImpl,
      TOKEN_URL,
      JSON.stringify({
        grant_type: 'authorization_code',
        client_id: CLAUDE_CLIENT_ID,
        code: result.code,
        state,
        redirect_uri: result.redirectUri,
        code_verifier: verifier,
      }),
      'json',
      { code: 'UNAUTHORIZED', message: 'Claude sign-in was rejected' },
    );
    if (!bundle.refreshToken) throwIpcError('UPSTREAM_ERROR', 'Claude sign-in returned no refresh token');
    return { tokens: bundle, accountLabel: accountLabelFrom(raw) };
  },

  async refresh(input, fetchImpl) {
    const { bundle } = await postTokenRequest(
      fetchImpl,
      TOKEN_URL,
      JSON.stringify({ grant_type: 'refresh_token', client_id: CLAUDE_CLIENT_ID, refresh_token: input.refreshToken }),
      'json',
      { code: 'UNAUTHORIZED', message: 'Claude token refresh failed' },
    );
    // Anthropic rotates refresh tokens (single use); keep the old one only if omitted.
    if (!bundle.refreshToken) bundle.refreshToken = input.refreshToken;
    return bundle;
  },
};
