// Cursor (cursor-agent) session reader — reads the token from the Keychain (macOS)
// or ~/.cursor/auth.json.
//
// On macOS the canonical source is the Keychain service "cursor-access-token" for
// account "cursor-user". Falls back to the auth file if Keychain is unavailable.
// No refresh needed — cursor-agent manages its own session.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agentHome } from '../providers/agentPaths';
import { readJsonObject } from '../providers/fsutil';

export interface CursorSessionSnapshot {
  available: boolean;
  accountLabel: string | null;
}

function cursorAuthFile(): string {
  const home = agentHome();
  switch (process.platform) {
    case 'win32': {
      const appData = process.env.APPDATA?.trim();
      const dir = appData || path.join(home, 'AppData', 'Roaming');
      return path.join(dir, 'Cursor', 'auth.json');
    }
    case 'darwin':
      return path.join(home, '.cursor', 'auth.json');
    default: {
      const xdg = process.env.XDG_CONFIG_HOME?.trim();
      const dir = xdg || path.join(home, '.config');
      return path.join(dir, 'cursor', 'auth.json');
    }
  }
}

function readTokenFromKeychain(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execSync(
      'security find-generic-password -s cursor-access-token -a cursor-user -w',
      { encoding: 'utf8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    if (out !== '') return out;
  } catch {
    // Keychain entry missing or command failed.
  }
  return null;
}

function readToken(): string | null {
  // macOS: prefer Keychain.
  const keychain = readTokenFromKeychain();
  if (keychain) return keychain;

  // Fall back to auth.json.
  const auth = readJsonObject(cursorAuthFile());
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : '';
  return accessToken || null;
}

function readEmail(): string | null {
  const auth = readJsonObject(cursorAuthFile());
  if (typeof auth.email === 'string' && auth.email) return auth.email;
  return null;
}

export function cursorAuthFileExists(): boolean {
  // Keychain takes priority on macOS, but the auth file is the portable check.
  if (readTokenFromKeychain()) return true;
  try {
    return fs.existsSync(cursorAuthFile());
  } catch {
    return false;
  }
}

export function cursorSessionSnapshot(): CursorSessionSnapshot {
  const token = readToken();
  if (!token) return { available: false, accountLabel: null };
  const email = readEmail();
  return { available: true, accountLabel: email || 'Cursor' };
}

export function readCursorAccessTokenSync(): string | null {
  return readToken();
}
