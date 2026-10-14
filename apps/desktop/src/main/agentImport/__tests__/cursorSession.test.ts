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
  cursorSessionSnapshot,
  readCursorAccessTokenSync,
} from '../cursorSession';

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
});
