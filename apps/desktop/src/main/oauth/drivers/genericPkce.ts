import { throwIpcError } from '../../ipc/validate';
import type { OAuthDriver, OAuthDriverContext, OAuthRefreshInput, OAuthTokenExchangeInput, OAuthFetch } from './types';
import type { OAuthTokenBundle } from '../oauthTokenStore';

function requireConfig(
  config: OAuthDriverContext['config'],
): { clientId: string; authorizeUrl: string; tokenUrl: string; scopes: string[] } {
  const clientId = config.clientId?.trim();
  const authorizeUrl = config.authorizeUrl?.trim();
  const tokenUrl = config.tokenUrl?.trim();
  if (!clientId || !authorizeUrl || !tokenUrl) {
    throwIpcError('PRECONDITION_FAILED', 'OAuth provider is missing client id or endpoints');
  }
  return { clientId, authorizeUrl, tokenUrl, scopes: config.scopes ?? [] };
}

function parseTokenResponse(body: unknown): OAuthTokenBundle {
  if (!body || typeof body !== 'object') throwIpcError('UPSTREAM_ERROR', 'invalid token response');
  const o = body as Record<string, unknown>;
  const accessToken = typeof o.access_token === 'string' ? o.access_token : '';
  if (accessToken === '') throwIpcError('UPSTREAM_ERROR', 'token response missing access_token');
  const bundle: OAuthTokenBundle = { accessToken, expiresAt: null };
  if (typeof o.refresh_token === 'string' && o.refresh_token !== '') bundle.refreshToken = o.refresh_token;
  if (typeof o.expires_in === 'number' && o.expires_in > 0) {
    bundle.expiresAt = Date.now() + o.expires_in * 1000;
  }
  return bundle;
}

async function postForm(
  fetchImpl: OAuthFetch,
  url: string,
  params: Record<string, string>,
): Promise<OAuthTokenBundle> {
  const body = new URLSearchParams(params).toString();
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  if (response.status === 401 || response.status === 403) {
    throwIpcError('UNAUTHORIZED', 'OAuth token endpoint rejected the request');
  }
  if (!response.ok) throwIpcError('UPSTREAM_ERROR', 'OAuth token exchange failed');
  return parseTokenResponse(await response.json());
}

export const genericPkceDriver: OAuthDriver = {
  kind: 'generic_pkce',

  buildAuthorizeUrl(ctx) {
    const { clientId, authorizeUrl, scopes } = requireConfig(ctx.config);
    const url = new URL(authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', ctx.redirectUri);
    url.searchParams.set('state', ctx.state);
    url.searchParams.set('code_challenge', ctx.pkceChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
    return url.toString();
  },

  exchangeCode(input: OAuthTokenExchangeInput, fetchImpl) {
    const { clientId, tokenUrl } = requireConfig(input.config);
    return postForm(fetchImpl, tokenUrl, {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: clientId,
      code_verifier: input.pkceVerifier,
    });
  },

  refresh(input: OAuthRefreshInput, fetchImpl) {
    const { clientId, tokenUrl } = requireConfig(input.config);
    return postForm(fetchImpl, tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: clientId,
    });
  },
};
