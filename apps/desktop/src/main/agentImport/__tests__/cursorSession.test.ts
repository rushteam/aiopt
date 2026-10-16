import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process.execSync so the macOS Keychain is never queried during tests.
vi.mock('node:child_process', () => ({
  execSync: () => {
    throw new Error('no keychain in test');
  },
}));

import {
  cursorAuthFileExists,
  cursorEditorStateDb,
  cursorSessionSnapshot,
  pickCursorToken,
  readCursorAccessTokenSync,
} from '../cursorSession';

const sqlite = (() => {
  try {
    return process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined;
  } catch {
    return undefined;
  }
})();

/** An unsigned JWT whose exp is `expSec` (seconds). */
function jwt(expSec: number): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none' })}.${b({ exp: expSec })}.sig`;
}

function writeEditorDb(rows: Record<string, string>): void {
  const file = cursorEditorStateDb();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite!.DatabaseSync(file);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const ins = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(rows)) ins.run(`cursorAuth/${k}`, v);
  db.close();
}

let home: string;
const originalAppData = process.env.APPDATA;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aiopt-cursor-import-'));
  process.env.AIOPT_AGENT_HOME = home;
  // GitHub's runners set XDG_CONFIG_HOME (Linux) and APPDATA (Windows), either of which
  // would move the auth file out of `home`.
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
});

afterEach(() => {
  delete process.env.AIOPT_AGENT_HOME;
  delete process.env.XDG_CONFIG_HOME;
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeAuth(data: unknown): void {
  // Use the path that cursorAuthFile() would resolve.
  // On macOS: $AIOPT_AGENT_HOME/.cursor/auth.json
  // On Windows: $APPDATA/Cursor/auth.json
  // On Linux: $XDG_CONFIG_HOME/cursor/auth.json
  const dir =
    process.platform === 'darwin'
      ? path.join(home, '.cursor')
      : process.platform === 'win32'
        ? path.join(home, 'AppData', 'Roaming', 'Cursor')
        : path.join(home, '.config', 'cursor');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(data), 'utf8');
}

describe('cursor session import', () => {
  it('reads the access token from auth.json', () => {
    writeAuth({ accessToken: 'cursor-tok-secret', email: 'user@cursor.com' });
    expect(cursorSessionSnapshot()).toEqual({ available: true, accountLabel: 'user@cursor.com' });
    expect(readCursorAccessTokenSync()).toBe('cursor-tok-secret');
  });

  it('returns unavailable when auth.json is missing', () => {
    expect(cursorSessionSnapshot()).toEqual({ available: false, accountLabel: null });
    expect(readCursorAccessTokenSync()).toBeNull();
  });

  it('returns unavailable when auth.json has no token', () => {
    writeAuth({ email: 'user@cursor.com' });
    expect(cursorSessionSnapshot().available).toBe(false);
  });

  it('falls back to Cursor label when email is absent', () => {
    writeAuth({ accessToken: 'tok' });
    expect(cursorSessionSnapshot()).toEqual({ available: true, accountLabel: 'Cursor' });
  });

  it('detects auth file', () => {
    expect(cursorAuthFileExists()).toBe(false);
    writeAuth({ accessToken: 'tok' });
    expect(cursorAuthFileExists()).toBe(true);
  });

  it('picks the token that runs longest', () => {
    const now = 1_800_000_000_000;
    const old = jwt(now / 1000 - 3600);
    const live = jwt(now / 1000 + 3600);
    expect(pickCursorToken([old, null, live], now)).toBe(live);
    expect(pickCursorToken([live, old], now)).toBe(live);
    expect(pickCursorToken([null, undefined], now)).toBeNull();
    expect(pickCursorToken([old], now)).toBe(old);
  });

  it.skipIf(!sqlite)("uses the editor's live token over cursor-agent's expired one", () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = jwt(now - 86_400);
    const live = jwt(now + 86_400);
    writeAuth({ accessToken: expired });
    writeEditorDb({ accessToken: live, cachedEmail: 'ed@cursor.com' });
    expect(readCursorAccessTokenSync()).toBe(live);
    expect(cursorSessionSnapshot()).toEqual({ available: true, accountLabel: 'ed@cursor.com' });
  });

  it.skipIf(!sqlite)('reads the editor sign-in alone', () => {
    const live = jwt(Math.floor(Date.now() / 1000) + 86_400);
    writeEditorDb({ accessToken: live });
    expect(cursorAuthFileExists()).toBe(true);
    expect(readCursorAccessTokenSync()).toBe(live);
  });
});
