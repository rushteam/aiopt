import fs from 'node:fs';
import path from 'node:path';
import { agentHome } from '../providers/agentPaths';
import { writeAgentConfigFile } from '../providers/fsutil';

const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_SKEW_MS = 60_000;

export interface ClaudeSessionSnapshot {
  available: boolean;
  accountLabel: string | null;
}

function credentialsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (dir && dir !== '') return path.join(dir, '.credentials.json');
  return path.join(agentHome(), '.claude', '.credentials.json');
}

function readRaw(): Record<string, unknown> | null {
  const file = credentialsPath();
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function readOAuth(raw: Record<string, unknown>): {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
} | null {
  const block = raw.claudeAiOauth;
  if (!block || typeof block !== 'object') return null;
  const o = block as Record<string, unknown>;
  const accessToken = typeof o.accessToken === 'string' ? o.accessToken : '';
  if (accessToken === '') return null;
  let expiresAtMs = 0;
  if (typeof o.expiresAt === 'number') {
    expiresAtMs = o.expiresAt < 1e12 ? o.expiresAt * 1000 : o.expiresAt;
  }
  return {
    accessToken,
    refreshToken: typeof o.refreshToken === 'string' ? o.refreshToken : '',
    expiresAtMs,
  };
}

export function claudeSessionSnapshot(): ClaudeSessionSnapshot {
  const raw = readRaw();
  if (!raw) return { available: false, accountLabel: null };
  const oauth = readOAuth(raw);
  if (!oauth) return { available: false, accountLabel: null };
  return { available: true, accountLabel: 'Claude Code' };
}

export function readClaudeAccessTokenSync(): string | null {
  const raw = readRaw();
  if (!raw) return null;
  return readOAuth(raw)?.accessToken ?? null;
}

async function refreshClaude(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<string | null> {
  const file = credentialsPath();
  const raw = readRaw();
  if (!raw) return null;
  const oauth = readOAuth(raw);
  if (!oauth || oauth.refreshToken === '') return null;
  const response = await fetchImpl(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as Record<string, unknown>;
  const access = typeof body.access_token === 'string' ? body.access_token : '';
  if (access === '') return null;
  const block = (raw.claudeAiOauth ?? {}) as Record<string, unknown>;
  block.accessToken = access;
  if (typeof body.refresh_token === 'string' && body.refresh_token !== '') {
    block.refreshToken = body.refresh_token;
  }
  if (typeof body.expires_in === 'number' && body.expires_in > 0) {
    block.expiresAt = Date.now() + body.expires_in * 1000;
  }
  raw.claudeAiOauth = block;
  writeAgentConfigFile(file, `${JSON.stringify(raw, null, 2)}\n`);
  return access;
}

export async function readClaudeAccessToken(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<string | null> {
  const raw = readRaw();
  if (!raw) return null;
  const oauth = readOAuth(raw);
  if (!oauth) return null;
  if (oauth.expiresAtMs === 0 || oauth.expiresAtMs > Date.now() + REFRESH_SKEW_MS) {
    return oauth.accessToken;
  }
  return (await refreshClaude(fetchImpl)) ?? oauth.accessToken;
}

export function claudeCredentialsFileExists(): boolean {
  try {
    return fs.existsSync(credentialsPath());
  } catch {
    return false;
  }
}
