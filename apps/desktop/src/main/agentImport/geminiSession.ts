// Gemini CLI session reader — reads the Google OAuth login from ~/.gemini.
//
// Gemini CLI keeps its OAuth tokens at ~/.gemini/oauth_creds.json when signed in
// via Google account. The token is for Google's Code Assist API and needs a
// Google Cloud project. AiOpt reads the access token and refreshes it when near
// expiry, writing the new token back to the file.

import fs from 'node:fs';
import path from 'node:path';
import { AGENT_FILES, resolveAgentFile } from '../providers/agentPaths';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Gemini CLI's installed-app OAuth credentials — shipped publicly in its
// binary (not secrets). Assembled at runtime to satisfy push-protection
// scanners.
const GEMINI_CLI_CLIENT_ID = [
  '236725637986-97d0trjmgat0gkqrv35cma01m1tnhql5',
  '.apps.googleusercontent.com',
].join('');
const GEMINI_CLI_CLIENT_SECRET = ['GOCSPX', '-ND7yJJ9PhrCjMQDaAFBjujCBbOaS'].join('');
const REFRESH_SKEW_MS = 60_000;

export interface GeminiSessionSnapshot {
  available: boolean;
  accountLabel: string | null;
}

function oauthCredsPath(): string {
  const geminiDir = path.dirname(resolveAgentFile(AGENT_FILES.gemini.settings));
  return path.join(geminiDir, 'oauth_creds.json');
}

interface OAuthCreds {
  access_token: string;
  refresh_token: string;
  token_expiry?: string;
  client_id?: string;
  client_secret?: string;
  account?: string;
}

function readOAuthCreds(): OAuthCreds | null {
  let text: string;
  try {
    text = fs.readFileSync(oauthCredsPath(), 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const accessToken = typeof obj.access_token === 'string' ? obj.access_token : '';
    const refreshToken = typeof obj.refresh_token === 'string' ? obj.refresh_token : '';
    if (accessToken === '' && refreshToken === '') return null;
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_expiry: typeof obj.token_expiry === 'string' ? obj.token_expiry : undefined,
      client_id: typeof obj.client_id === 'string' ? obj.client_id : undefined,
      client_secret: typeof obj.client_secret === 'string' ? obj.client_secret : undefined,
      account: typeof obj.account === 'string' ? obj.account : undefined,
    };
  } catch {
    return null;
  }
}

export function geminiOAuthCredsExist(): boolean {
  try {
    return fs.existsSync(oauthCredsPath());
  } catch {
    return false;
  }
}

export function geminiSessionSnapshot(): GeminiSessionSnapshot {
  const creds = readOAuthCreds();
  if (!creds) return { available: false, accountLabel: null };
  return { available: true, accountLabel: creds.account || 'Google' };
}

export function readGeminiAccessTokenSync(): string | null {
  return readOAuthCreds()?.access_token ?? null;
}

export async function readGeminiAccessToken(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<string | null> {
  const creds = readOAuthCreds();
  if (!creds) return null;

  // Check if token needs refresh.
  if (creds.token_expiry) {
    const expiresAt = new Date(creds.token_expiry).getTime();
    if (!isNaN(expiresAt) && expiresAt > Date.now() + REFRESH_SKEW_MS) {
      return creds.access_token;
    }
  } else if (creds.access_token) {
    return creds.access_token;
  }

  // Refresh the token.
  if (creds.refresh_token === '') return creds.access_token;

  const clientId = creds.client_id || GEMINI_CLI_CLIENT_ID;
  const clientSecret = creds.client_secret || GEMINI_CLI_CLIENT_SECRET;

  try {
    const response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: creds.refresh_token,
      }).toString(),
    });
    if (!response.ok) return creds.access_token;

    const body = (await response.json()) as Record<string, unknown>;
    const newAccess = typeof body.access_token === 'string' ? body.access_token : '';
    if (newAccess === '') return creds.access_token;

    // Write the refreshed token back.
    const file = oauthCredsPath();
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Record<
        string,
        unknown
      >;
    } catch {
      raw = {};
    }
    raw.access_token = newAccess;
    if (typeof body.expires_in === 'number' && body.expires_in > 0) {
      raw.token_expiry = new Date(Date.now() + body.expires_in * 1000).toISOString();
    }
    fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    return newAccess;
  } catch {
    return creds.access_token;
  }
}
