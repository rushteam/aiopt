// GitHub Copilot OAuth driver — GitHub device-code flow, then the Copilot token exchange.
//
// Uses the Copilot editor plugins' public client id. The long-lived GitHub OAuth token is
// stored as the bundle's refresh token; the short-lived (~30 min) Copilot API token is the
// access token, re-exchanged by `refresh` before it expires. The user code is shown in a
// main-owned native dialog, never handed to the renderer. github.com only (no GHE yet).
// See oauth-providers.md for the ToS note.

import { throwIpcError } from '../../ipc/validate';
import type { OAuthTokenBundle } from '../oauthTokenStore';
import { EXPIRY_MARGIN_MS, formBody, LOGIN_TIMEOUT_MS } from './subscriptionCommon';
import type { OAuthDriver, OAuthFetch } from './types';

export const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const USER_URL = 'https://api.github.com/user';

/** Editor identity Copilot's API requires on every call (shared with proxy/subscriptionWire.ts). */
export const COPILOT_EDITOR_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function readJson(fetchImpl: OAuthFetch, url: string, init: Parameters<OAuthFetch>[1]) {
  let res: Awaited<ReturnType<OAuthFetch>>;
  try {
    res = await fetchImpl(url, init);
  } catch {
    throwIpcError('UPSTREAM_ERROR', 'could not reach GitHub');
  }
  return { ok: res.ok, status: res.status, body: asRecord(await res.json().catch(() => null)) };
}

/** Only GitHub's own device page may be opened from a server-supplied URL. */
export function trustedVerificationUri(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Exchange a GitHub OAuth token for a short-lived Copilot API token. */
export async function exchangeCopilotToken(
  fetchImpl: OAuthFetch,
  githubToken: string,
): Promise<OAuthTokenBundle> {
  const res = await readJson(fetchImpl, COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${githubToken}`, ...COPILOT_EDITOR_HEADERS },
  });
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throwIpcError('UNAUTHORIZED', 'this GitHub account has no active Copilot subscription');
  }
  const token = res.body?.token;
  const expiresAt = res.body?.expires_at;
  if (!res.ok || typeof token !== 'string' || token === '' || typeof expiresAt !== 'number') {
    throwIpcError('UPSTREAM_ERROR', 'GitHub returned an unreadable Copilot token');
  }
  return { accessToken: token, refreshToken: githubToken, expiresAt: expiresAt * 1000 - EXPIRY_MARGIN_MS };
}

/**
 * The Copilot API base a token is bound to: its `proxy-ep=proxy.X` field becomes
 * `https://api.X`. Null when absent or not a githubcopilot.com host.
 */
export function copilotBaseFromToken(token: string): string | null {
  const m = /(?:^|;)proxy-ep=([^;]+)/.exec(token);
  if (!m) return null;
  const host = m[1]!.trim().replace(/^proxy\./, 'api.');
  if (!/^[a-z0-9.-]+$/i.test(host) || !(host === 'githubcopilot.com' || host.endsWith('.githubcopilot.com'))) {
    return null;
  }
  return `https://${host}`;
}

export const githubCopilotDriver: OAuthDriver = {
  kind: 'github_copilot',

  buildAuthorizeUrl() {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Copilot OAuth uses the device-code login path');
  },

  async exchangeCode() {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Copilot OAuth uses the device-code login path');
  },

  async runLogin(deps) {
    if (!deps.showDeviceCode) throwIpcError('UNSUPPORTED_CAPABILITY', 'device-code login is unavailable');
    const sleep = deps.sleep ?? defaultSleep;
    const formHeaders = {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'User-Agent': COPILOT_EDITOR_HEADERS['User-Agent']!,
    };

    const device = await readJson(deps.fetchImpl, DEVICE_CODE_URL, {
      method: 'POST',
      headers: formHeaders,
      body: formBody({ client_id: COPILOT_CLIENT_ID, scope: 'read:user' }),
    });
    const deviceCode = device.body?.device_code;
    const userCode = device.body?.user_code;
    const verificationUri = trustedVerificationUri(device.body?.verification_uri);
    if (!device.ok || typeof deviceCode !== 'string' || typeof userCode !== 'string' || !verificationUri) {
      throwIpcError('UPSTREAM_ERROR', 'GitHub returned an unreadable device code');
    }
    let intervalMs = Math.max(1, Number(device.body?.interval) || 5) * 1000;
    const expiresInMs = (Number(device.body?.expires_in) || 900) * 1000;
    const deadline = Date.now() + Math.min(expiresInMs, LOGIN_TIMEOUT_MS * 3);

    if (!(await deps.showDeviceCode({ userCode, verificationUri }))) {
      throwIpcError('PRECONDITION_FAILED', 'OAuth login was cancelled or failed');
    }
    if (!(await deps.openExternal(verificationUri))) {
      throwIpcError('PRECONDITION_FAILED', 'could not open the system browser');
    }

    let githubToken: string | null = null;
    while (Date.now() < deadline) {
      await sleep(intervalMs);
      const poll = await readJson(deps.fetchImpl, ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: formHeaders,
        body: formBody({
          client_id: COPILOT_CLIENT_ID,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const access = poll.body?.access_token;
      if (typeof access === 'string' && access !== '') {
        githubToken = access;
        break;
      }
      const error = poll.body?.error;
      if (error === 'authorization_pending') continue;
      if (error === 'slow_down') {
        const next = Number(poll.body?.interval);
        intervalMs = Number.isFinite(next) && next > 0 ? next * 1000 : intervalMs + 5000;
        continue;
      }
      throwIpcError('PRECONDITION_FAILED', 'OAuth login was cancelled or failed');
    }
    if (!githubToken) throwIpcError('PRECONDITION_FAILED', 'OAuth login timed out');

    const tokens = await exchangeCopilotToken(deps.fetchImpl, githubToken);
    // Best-effort account label (the login name); a failure leaves the default label.
    let accountLabel: string | undefined;
    try {
      const user = await readJson(deps.fetchImpl, USER_URL, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${githubToken}`, ...COPILOT_EDITOR_HEADERS },
      });
      if (typeof user.body?.login === 'string' && user.body.login !== '') accountLabel = user.body.login;
    } catch {
      // label only
    }
    return { tokens, accountLabel };
  },

  async refresh(input, fetchImpl) {
    // The "refresh token" is the GitHub OAuth token; re-exchange it for a fresh Copilot token.
    return exchangeCopilotToken(fetchImpl, input.refreshToken);
  },
};
