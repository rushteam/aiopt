import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  grokInstallDirExists,
  grokSessionSnapshot,
  readGrokAccessTokenSync,
} from '../grokSession';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'aiopt-grok-import-'));
  process.env.AIOPT_AGENT_HOME = home;
  delete process.env.GROK_HOME;
});

afterEach(() => {
  delete process.env.AIOPT_AGENT_HOME;
  delete process.env.GROK_HOME;
});

function writeAuth(data: unknown): void {
  const dir = path.join(home, '.grok');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(data), 'utf8');
}

describe('grok session import', () => {
  it('reads the access token from auth.json', () => {
    writeAuth({ default: { key: 'xai-secret-key', email: 'user@x.ai' } });
    expect(grokSessionSnapshot()).toEqual({ available: true, accountLabel: 'user@x.ai' });
    expect(readGrokAccessTokenSync()).toBe('xai-secret-key');
  });

  it('returns unavailable when auth.json is missing', () => {
    expect(grokSessionSnapshot()).toEqual({ available: false, accountLabel: null });
    expect(readGrokAccessTokenSync()).toBeNull();
  });

  it('returns unavailable when auth.json has no valid entry', () => {
    writeAuth({ default: { email: 'user@x.ai' } });
    expect(grokSessionSnapshot().available).toBe(false);
  });

  it('uses GROK_HOME when set', () => {
    const alt = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'aiopt-grok-alt-'));
    process.env.GROK_HOME = alt;
    fs.writeFileSync(path.join(alt, 'auth.json'), JSON.stringify({ a: { key: 'k1', email: 'alt@x.ai' } }), 'utf8');
    expect(grokSessionSnapshot().accountLabel).toBe('alt@x.ai');
    expect(readGrokAccessTokenSync()).toBe('k1');
  });

  it('falls back to SuperGrok label when email is empty', () => {
    writeAuth({ default: { key: 'k', email: '' } });
    expect(grokSessionSnapshot()).toEqual({ available: true, accountLabel: 'SuperGrok' });
  });

  it('detects install dir', () => {
    expect(grokInstallDirExists()).toBe(false);
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    expect(grokInstallDirExists()).toBe(true);
  });
});
