import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createProviderStore } from '../../providers/providerStore';
import { createSecretStore, type SecretCryptor } from '../../secrets/secretStore';
import { createOAuthManager } from '../oauthManager';
import { oauthProviderSecretKey } from '../oauthTokenStore';
import type { Provider } from '../../../shared/aiProviders';

const noopCryptor: SecretCryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString(),
};

function memorySecrets() {
  const dir = '/tmp/oauth-test-secrets';
  return createSecretStore(dir, noopCryptor);
}

function oauthProvider(id: string): Provider {
  return {
    id,
    name: 'OAuth test',
    apiFormats: ['openai'],
    baseUrl: 'https://api.example.com',
    models: [{ id: 'm1' }],
    createdAt: 1,
    credentialMode: 'oauth',
    oauth: {
      kind: 'generic_pkce',
      clientId: 'client',
      authorizeUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
    },
  };
}

describe('oauth manager — disconnect', () => {
  it('clears stored tokens and marks disconnected', () => {
    const store = createProviderStore({ load: () => ({}), save: () => {} });
    const secrets = memorySecrets();
    store.addProvider(oauthProvider('p1'));
    secrets.set(
      oauthProviderSecretKey('p1'),
      JSON.stringify({ accessToken: 'at', expiresAt: null }),
    );
    const onChanged = vi.fn();
    const oauth = createOAuthManager({
      store,
      secrets,
      fetchImpl: vi.fn(),
      onProvidersChanged: onChanged,
    });
    expect(oauth.isConnected('p1')).toBe(true);
    oauth.disconnect('p1');
    expect(oauth.isConnected('p1')).toBe(false);
    expect(secrets.get(oauthProviderSecretKey('p1'))).toBeNull();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(store.getProvider('p1')?.oauth?.accountLabel).toBeUndefined();
  });
});

describe('oauth manager — token refresh', () => {
  function setup(fetchImpl: ReturnType<typeof vi.fn>) {
    const dir = mkdtempSync(join(tmpdir(), 'aiopt-oauth-refresh-'));
    const store = createProviderStore({ load: () => ({}), save: () => {} });
    const secrets = createSecretStore(dir, noopCryptor);
    store.addProvider({ ...oauthProvider('c1'), apiFormats: ['anthropic'], oauth: { kind: 'anthropic_claude' } });
    secrets.set(
      oauthProviderSecretKey('c1'),
      JSON.stringify({ accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000 }),
    );
    const oauth = createOAuthManager({ store, secrets, fetchImpl, onProvidersChanged: () => {} });
    return { oauth, secrets, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  const okReply = (access: string, refresh: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: access, refresh_token: refresh, expires_in: 3600 }),
  });

  it('runs concurrent refreshes once (refresh tokens rotate)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return okReply('new', 'r2');
    });
    const { oauth, secrets, cleanup } = setup(fetchImpl);
    try {
      const a = oauth.getAccessToken('c1');
      const b = oauth.getAccessToken('c1');
      release();
      expect(await a).toBe('new');
      expect(await b).toBe('new');
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(JSON.parse(secrets.get(oauthProviderSecretKey('c1'))!).refreshToken).toBe('r2');
    } finally {
      cleanup();
    }
  });

  it('backs off after a failed refresh', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) }));
    const { oauth, cleanup } = setup(fetchImpl);
    try {
      expect(await oauth.getAccessToken('c1')).toBeNull();
      expect(await oauth.getAccessToken('c1')).toBeNull();
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      cleanup();
    }
  });

  it('does not resurrect tokens cleared by a disconnect mid-refresh', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return okReply('new', 'r2');
    });
    const { oauth, secrets, cleanup } = setup(fetchImpl);
    try {
      const pending = oauth.getAccessToken('c1');
      await Promise.resolve();
      oauth.disconnect('c1');
      release();
      expect(await pending).toBeNull();
      expect(secrets.get(oauthProviderSecretKey('c1'))).toBeNull();
    } finally {
      cleanup();
    }
  });
});
