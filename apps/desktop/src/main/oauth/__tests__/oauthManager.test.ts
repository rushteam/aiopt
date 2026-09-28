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
