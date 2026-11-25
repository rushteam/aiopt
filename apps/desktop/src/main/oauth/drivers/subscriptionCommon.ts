// Shared helpers for the built-in subscription OAuth drivers (ChatGPT / Claude / Copilot).
//
// The drivers mirror the vendors' own CLI login flows and borrow their public client ids;
// see docs/dev-rules/oauth-providers.md ("Built-in subscription drivers") for the ToS note.
// Nothing here logs or returns a token outside the bundle handed back to the manager.

import { throwIpcError } from '../../ipc/validate';
import { startOAuthCallbackServer, type OAuthCallbackServerOptions } from '../callbackServer';
import type { OAuthTokenBundle } from '../oauthTokenStore';
import type { OAuthFetch } from './types';

/** Refresh a little before the vendor's stated expiry so a request never races it. */
export const EXPIRY_MARGIN_MS = 5 * 60_000;

/** How long a browser / device-code login may take before the flow gives up. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

export function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** POST to a token endpoint and read a standard `{access_token, refresh_token?, expires_in}` reply. */
export async function postTokenRequest(
  fetchImpl: OAuthFetch,
  url: string,
  body: string,
  contentType: 'form' | 'json',
  failure: { code: 'UNAUTHORIZED' | 'UPSTREAM_ERROR'; message: string },
  now: () => number = Date.now,
): Promise<{ bundle: OAuthTokenBundle; raw: Record<string, unknown> }> {
  let res: Awaited<ReturnType<OAuthFetch>>;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': contentType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json',
        accept: 'application/json',
      },
      body,
    });
  } catch {
    throwIpcError('UPSTREAM_ERROR', 'could not reach the sign-in server');
  }
  // The vendor's error body may echo request fields; never surface it.
  if (!res.ok) throwIpcError(failure.code, failure.message);
  const raw = asRecord(await res.json().catch(() => null));
  const access = raw?.access_token;
  if (!raw || typeof access !== 'string' || access === '') {
    throwIpcError('UPSTREAM_ERROR', 'the sign-in server returned an unreadable token response');
  }
  const bundle: OAuthTokenBundle = { accessToken: access, expiresAt: null };
  if (typeof raw.refresh_token === 'string' && raw.refresh_token !== '') bundle.refreshToken = raw.refresh_token;
  if (typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in) && raw.expires_in > 0) {
    bundle.expiresAt = now() + raw.expires_in * 1000 - EXPIRY_MARGIN_MS;
  }
  return { bundle, raw };
}

/**
 * Run one browser authorization-code round trip on a vendor-fixed loopback port. A port
 * already in use (e.g. the vendor's own CLI mid-login) fails loudly instead of silently
 * picking another port the vendor would reject — unless the vendor accepts any loopback
 * port (`fallbackToEphemeral`).
 */
export async function browserAuthorize(
  openExternal: (url: string) => Promise<boolean>,
  server: OAuthCallbackServerOptions & { fallbackToEphemeral?: boolean },
  buildUrl: (redirectUri: string) => string,
  state: string,
): Promise<{ code: string; redirectUri: string }> {
  let cb: Awaited<ReturnType<typeof startOAuthCallbackServer>>;
  const { fallbackToEphemeral, ...listen } = server;
  try {
    cb = await startOAuthCallbackServer({ timeoutMs: LOGIN_TIMEOUT_MS, ...listen });
  } catch {
    if (fallbackToEphemeral) {
      cb = await startOAuthCallbackServer({ timeoutMs: LOGIN_TIMEOUT_MS, ...listen, port: 0 }).catch(() =>
        throwIpcError('PRECONDITION_FAILED', 'could not start the sign-in callback listener'),
      );
    } else throwIpcError('PRECONDITION_FAILED', `the sign-in callback port ${server.port ?? 0} is in use`);
  }
  try {
    const opened = await openExternal(buildUrl(cb.redirectUri));
    if (!opened) throwIpcError('PRECONDITION_FAILED', 'could not open the system browser');
    const result = await cb.result;
    if (result.state !== state) throwIpcError('UNAUTHORIZED', 'OAuth state mismatch');
    if (result.error || !result.code) throwIpcError('PRECONDITION_FAILED', 'OAuth login was cancelled or failed');
    return { code: result.code, redirectUri: cb.redirectUri };
  } finally {
    cb.close();
  }
}
