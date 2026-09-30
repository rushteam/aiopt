// Grok session reader — reads the Grok CLI's sign-in from ~/.grok/auth.json.
//
// The file is a JSON object keyed by account id, each value {key, email, expires_at}.
// The `key` is the access token for xAI's Responses API. The CLI refreshes it
// internally; AiOpt only reads it (no write-back).

import fs from 'node:fs';
import path from 'node:path';
import { agentHome } from '../providers/agentPaths';

export interface GrokSessionSnapshot {
  available: boolean;
  accountLabel: string | null;
}

function grokHome(): string {
  const override = process.env.GROK_HOME?.trim();
  if (override) return override;
  return path.join(agentHome(), '.grok');
}

function authPath(): string {
  return path.join(grokHome(), 'auth.json');
}

interface GrokCredential {
  key: string;
  email: string;
  expires_at?: string;
}

function readCredential(): GrokCredential | null {
  let text: string;
  try {
    text = fs.readFileSync(authPath(), 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries = parsed as Record<string, unknown>;
    // The file is keyed by account id; take the first valid entry.
    for (const value of Object.values(entries)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      const key = typeof entry.key === 'string' ? entry.key : '';
      const email = typeof entry.email === 'string' ? entry.email : '';
      if (key !== '') return { key, email };
    }
  } catch {
    return null;
  }
  return null;
}

export function grokInstallDirExists(): boolean {
  try {
    return fs.existsSync(grokHome());
  } catch {
    return false;
  }
}

export function grokSessionSnapshot(): GrokSessionSnapshot {
  const cred = readCredential();
  if (!cred) return { available: false, accountLabel: null };
  return { available: true, accountLabel: cred.email || 'SuperGrok' };
}

export function readGrokAccessTokenSync(): string | null {
  return readCredential()?.key ?? null;
}
