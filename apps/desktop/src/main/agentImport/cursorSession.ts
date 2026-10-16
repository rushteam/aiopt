// Cursor session reader. A Cursor sign-in can live in three places, and they drift apart:
//   - cursor-agent's Keychain entry (macOS: service "cursor-access-token", account "cursor-user"),
//   - cursor-agent's auth.json (off the Keychain),
//   - the Cursor editor's own state.vscdb (`cursorAuth/accessToken`), which the editor keeps
//     renewing while cursor-agent's copy can sit expired for months.
// Every source is read (read-only, per call) and the token that runs longest wins, so an
// expired cursor-agent token never shadows the editor's live one. Nothing is ever written.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agentHome } from '../providers/agentPaths';
import { readJsonObject } from '../providers/fsutil';
import { jwtExpMs } from './jwtPayload';

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

/** The Cursor editor's global state database (`state.vscdb`). */
export function cursorEditorStateDb(): string {
  const home = agentHome();
  switch (process.platform) {
    case 'win32': {
      const appData = process.env.APPDATA?.trim();
      return path.join(appData || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    }
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    default: {
      const xdg = process.env.XDG_CONFIG_HOME?.trim();
      return path.join(xdg || path.join(home, '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    }
  }
}

type DatabaseSyncCtor = typeof import('node:sqlite').DatabaseSync;
let databaseSync: DatabaseSyncCtor | null | undefined;
function sqliteDatabase(): DatabaseSyncCtor | null {
  if (databaseSync !== undefined) return databaseSync;
  try {
    databaseSync = (process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined)?.DatabaseSync ?? null;
  } catch {
    databaseSync = null;
  }
  return databaseSync;
}

/** `cursorAuth/<key>` values from the editor's state.vscdb (read-only), or {} when unreadable. */
function readEditorAuth(keys: readonly string[]): Record<string, string> {
  const file = cursorEditorStateDb();
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return {};
  } catch {
    return {};
  }
  const DatabaseSync = sqliteDatabase();
  if (!DatabaseSync) return {};
  const out: Record<string, string> = {};
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
      for (const k of keys) {
        const row = stmt.get(`cursorAuth/${k}`) as { value?: unknown } | undefined;
        const v = row?.value;
        const text = typeof v === 'string' ? v : v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : '';
        if (text.trim()) out[k] = text.trim();
      }
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
  return out;
}

function authFileToken(): string | null {
  const auth = readJsonObject(cursorAuthFile());
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken.trim() : '';
  return accessToken || null;
}

/** Of the candidate tokens, the one that runs longest (a token with no exp counts as live). */
export function pickCursorToken(candidates: readonly (string | null | undefined)[], now = Date.now()): string | null {
  let best: string | null = null;
  let bestExp = -Infinity;
  for (const t of candidates) {
    if (!t) continue;
    const exp = jwtExpMs(t) ?? now + 1;
    if (exp > bestExp) {
      best = t;
      bestExp = exp;
    }
  }
  return best;
}

function readToken(): string | null {
  return pickCursorToken([readTokenFromKeychain(), authFileToken(), readEditorAuth(['accessToken']).accessToken]);
}

function readEmail(): string | null {
  const auth = readJsonObject(cursorAuthFile());
  if (typeof auth.email === 'string' && auth.email) return auth.email;
  return readEditorAuth(['cachedEmail']).cachedEmail ?? null;
}

export function cursorAuthFileExists(): boolean {
  // Keychain takes priority on macOS, but the auth file is the portable check.
  if (readTokenFromKeychain()) return true;
  try {
    return fs.existsSync(cursorAuthFile()) || fs.existsSync(cursorEditorStateDb());
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
