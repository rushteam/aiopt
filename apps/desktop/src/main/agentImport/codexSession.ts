import fs from 'node:fs';
import { AGENT_FILES, resolveAgentFile } from '../providers/agentPaths';
import { readJsonObject, writeAgentConfigFile } from '../providers/fsutil';
import { decodeJwtPayload, jwtExpMs } from './jwtPayload';

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface CodexSessionSnapshot {
  available: boolean;
  accountLabel: string | null;
}

function authPath(): string {
  return resolveAgentFile(AGENT_FILES.codex.auth);
}

function readTokens(): {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  authMode: string;
} | null {
  const auth = readJsonObject(authPath());
  const authMode = typeof auth.auth_mode === 'string' ? auth.auth_mode : '';
  if (authMode === 'apikey') return null;
  const tokens = auth.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  const t = tokens as Record<string, unknown>;
  const accessToken = typeof t.access_token === 'string' ? t.access_token : '';
  if (accessToken === '') return null;
  return {
    accessToken,
    refreshToken: typeof t.refresh_token === 'string' ? t.refresh_token : '',
    idToken: typeof t.id_token === 'string' ? t.id_token : '',
    authMode,
  };
}

export function codexSessionSnapshot(): CodexSessionSnapshot {
  const tok = readTokens();
  if (!tok) return { available: false, accountLabel: null };
  const claims = tok.idToken !== '' ? decodeJwtPayload(tok.idToken) : null;
  const email = typeof claims?.email === 'string' ? claims.email : null;
  return { available: true, accountLabel: email ?? 'ChatGPT' };
}

async function refreshCodexTokens(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<string | null> {
  const path = authPath();
  const raw = readJsonObject(path);
  const tokens = raw.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  const t = tokens as Record<string, unknown>;
  const refresh = typeof t.refresh_token === 'string' ? t.refresh_token : '';
  if (refresh === '') return null;

  const response = await fetchImpl(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refresh,
      scope: 'openid profile email',
    }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as Record<string, unknown>;
  const access = typeof body.access_token === 'string' ? body.access_token : '';
  if (access === '') return null;
  if (typeof body.id_token === 'string' && body.id_token !== '') t.id_token = body.id_token;
  if (typeof body.refresh_token === 'string' && body.refresh_token !== '') {
    t.refresh_token = body.refresh_token;
  }
  t.access_token = access;
  raw.tokens = t;
  raw.last_refresh = new Date().toISOString();
  writeAgentConfigFile(path, `${JSON.stringify(raw, null, 2)}\n`);
  return access;
}

export function readCodexAccessTokenSync(): string | null {
  return readTokens()?.accessToken ?? null;
}

export async function readCodexAccessToken(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<string | null> {
  const tok = readTokens();
  if (!tok) return null;
  const expMs = jwtExpMs(tok.accessToken);
  if (expMs === null || expMs > Date.now() + REFRESH_SKEW_MS) return tok.accessToken;
  return (await refreshCodexTokens(fetchImpl)) ?? tok.accessToken;
}

export function codexAuthFileExists(): boolean {
  try {
    return fs.existsSync(authPath());
  } catch {
    return false;
  }
}
