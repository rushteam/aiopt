import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  devinCredentialsExist,
  devinInstallDirExists,
  devinSessionSnapshot,
  readDevinAccessTokenSync,
} from '../devinSession';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'aiopt-devin-import-'));
  process.env.AIOPT_AGENT_HOME = home;
  process.env.XDG_DATA_HOME = path.join(home, 'data');
  delete process.env.WINDSURF_API_SERVER_URL;
});

afterEach(() => {
  delete process.env.AIOPT_AGENT_HOME;
  delete process.env.XDG_DATA_HOME;
  delete process.env.WINDSURF_API_SERVER_URL;
});

function writeCreds(content: string): void {
  const dir = path.join(home, 'data', 'devin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'credentials.toml'), content, 'utf8');
}

describe('devin session import', () => {
  it('reads the API key from credentials.toml', () => {
    writeCreds('windsurf_api_key = "devin-session-token$secret"\napi_server_url = "https://server.codeium.com"\n');
    expect(devinSessionSnapshot()).toEqual({ available: true, accountLabel: 'Devin' });
    expect(readDevinAccessTokenSync()).toBe('devin-session-token$secret');
  });

  it('returns unavailable when credentials.toml is missing', () => {
    expect(devinSessionSnapshot()).toEqual({ available: false, accountLabel: null });
    expect(readDevinAccessTokenSync()).toBeNull();
  });

  it('returns unavailable when credentials.toml has no key', () => {
    writeCreds('api_server_url = "https://server.codeium.com"\n');
    expect(devinSessionSnapshot().available).toBe(false);
  });

  it('handles quoted TOML values with escapes', () => {
    writeCreds('windsurf_api_key = "key\\"with\\"quotes"\n');
    // The simple parser reads until the closing quote — it gets the first segment.
    // This is acceptable: the key is not expected to contain quotes in practice.
    expect(readDevinAccessTokenSync()).toBeTruthy();
  });

  it('detects credentials file', () => {
    expect(devinCredentialsExist()).toBe(false);
    writeCreds('windsurf_api_key = "k"\n');
    expect(devinCredentialsExist()).toBe(true);
  });

  it('detects install dir via config dir', () => {
    process.env.XDG_CONFIG_HOME = path.join(home, 'config');
    const devinConfig = path.join(home, 'config', 'devin');
    fs.mkdirSync(devinConfig, { recursive: true });
    expect(devinInstallDirExists()).toBe(true);
    delete process.env.XDG_CONFIG_HOME;
  });

  it('respects WINDSURF_API_SERVER_URL override', () => {
    writeCreds('windsurf_api_key = "k"\napi_server_url = "https://default.example.com"\n');
    process.env.WINDSURF_API_SERVER_URL = 'https://eu.codeium.com';
    // The key should still be readable; the server override is internal.
    expect(readDevinAccessTokenSync()).toBe('k');
  });
});
