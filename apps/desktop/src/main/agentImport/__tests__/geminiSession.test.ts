import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  geminiOAuthCredsExist,
  geminiSessionSnapshot,
  readGeminiAccessToken,
  readGeminiAccessTokenSync,
} from '../geminiSession';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'aiopt-gemini-import-'));
  process.env.AIOPT_AGENT_HOME = home;
});

afterEach(() => {
  delete process.env.AIOPT_AGENT_HOME;
});

function writeOAuthCreds(data: unknown): void {
  const dir = path.join(home, '.gemini');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'oauth_creds.json'), JSON.stringify(data), 'utf8');
}

describe('gemini session import', () => {
  it('reads the access token from oauth_creds.json', () => {
    writeOAuthCreds({
      access_token: 'ya29.google-access',
      refresh_token: 'rt-google',
      account: 'user@gmail.com',
    });
    expect(geminiSessionSnapshot()).toEqual({ available: true, accountLabel: 'user@gmail.com' });
    expect(readGeminiAccessTokenSync()).toBe('ya29.google-access');
  });

  it('returns unavailable when oauth_creds.json is missing', () => {
    expect(geminiSessionSnapshot()).toEqual({ available: false, accountLabel: null });
    expect(readGeminiAccessTokenSync()).toBeNull();
  });

  it('returns unavailable when file has no tokens', () => {
    writeOAuthCreds({ account: 'user@gmail.com' });
    expect(geminiSessionSnapshot().available).toBe(false);
  });

  it('falls back to Google label when account is empty', () => {
    writeOAuthCreds({ access_token: 'at', refresh_token: 'rt' });
    expect(geminiSessionSnapshot()).toEqual({ available: true, accountLabel: 'Google' });
  });

  it('detects oauth_creds file', () => {
    expect(geminiOAuthCredsExist()).toBe(false);
    writeOAuthCreds({ access_token: 'at', refresh_token: 'rt' });
    expect(geminiOAuthCredsExist()).toBe(true);
  });

  it('returns current token when not expired', async () => {
    writeOAuthCreds({
      access_token: 'ya29.still-good',
      refresh_token: 'rt',
      token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const fetchImpl = vi.fn();
    const token = await readGeminiAccessToken(fetchImpl);
    expect(token).toBe('ya29.still-good');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes an expired token', async () => {
    writeOAuthCreds({
      access_token: 'ya29.old',
      refresh_token: 'rt-refresh',
      token_expiry: new Date(Date.now() - 60_000).toISOString(),
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'ya29.fresh', expires_in: 3600 }),
    });
    const token = await readGeminiAccessToken(fetchImpl);
    expect(token).toBe('ya29.fresh');
    expect(fetchImpl).toHaveBeenCalledOnce();
    // Verify the file was updated.
    const file = path.join(home, '.gemini', 'oauth_creds.json');
    const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(updated.access_token).toBe('ya29.fresh');
    expect(updated.token_expiry).toBeDefined();
  });

  it('returns old token when refresh fails', async () => {
    writeOAuthCreds({
      access_token: 'ya29.old',
      refresh_token: 'rt',
      token_expiry: new Date(Date.now() - 60_000).toISOString(),
    });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false });
    const token = await readGeminiAccessToken(fetchImpl);
    expect(token).toBe('ya29.old');
  });
});
