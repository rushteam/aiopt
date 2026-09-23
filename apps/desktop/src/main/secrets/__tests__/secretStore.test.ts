import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeSecretKey,
  createSecretStore,
  isRendererAccessibleSecretKey,
  MAIN_ONLY_SECRET_PREFIX,
  type SecretCryptor,
} from '../secretStore';
import { decodeIpcError, isIpcError } from '../../../shared/ipc-errors';

/**
 * A fake cryptor: reversible but opaque (base64 behind a tag) so the store's file
 * + key logic is exercised without the OS keychain, and the on-disk bytes do not
 * literally contain the plaintext. `available` toggles the unavailable branch.
 */
function fakeCryptor(available = true): SecretCryptor {
  const TAG = 'enc1:';
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plaintext) => Buffer.from(TAG + Buffer.from(plaintext, 'utf8').toString('base64'), 'utf8'),
    decryptString: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith(TAG)) throw new Error('not decryptable');
      return Buffer.from(s.slice(TAG.length), 'base64').toString('utf8');
    },
  };
}

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (isIpcError(err)) return err.code;
    if (err instanceof Error) return decodeIpcError(err.message).code;
  }
  throw new Error('expected the call to throw a coded error');
}

describe('secret key validation', () => {
  it('accepts alphanumeric / underscore / dash keys', () => {
    expect(() => assertSafeSecretKey('main_auth_token')).not.toThrow();
    expect(() => assertSafeSecretKey('api-key_1')).not.toThrow();
  });

  it('rejects path-traversal and separator characters with INVALID_PARAMS', () => {
    for (const bad of ['../evil', 'a/b', 'a.b', 'a b', '', 'a$b']) {
      expect(codeOf(() => assertSafeSecretKey(bad))).toBe('INVALID_PARAMS');
    }
  });

  it('classifies main-only keys as not renderer-accessible', () => {
    expect(isRendererAccessibleSecretKey(`${MAIN_ONLY_SECRET_PREFIX}auth_token`)).toBe(false);
    expect(isRendererAccessibleSecretKey('api_key')).toBe(true);
  });
});

describe('secret store', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-secrets-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('set → get round-trips through an encrypted file', () => {
    const store = createSecretStore(dir, fakeCryptor());
    store.set('api_key', 'shhh');
    expect(store.has('api_key')).toBe(true);
    expect(store.get('api_key')).toBe('shhh');
  });

  it('writes the .enc file UNDER the secrets dir (no traversal escape)', () => {
    const store = createSecretStore(dir, fakeCryptor());
    store.set('api_key', 'shhh');
    const file = path.join(dir, 'api_key.enc');
    expect(fs.existsSync(file)).toBe(true);
    // The on-disk bytes are the ciphertext, never the plaintext.
    expect(fs.readFileSync(file, 'utf8')).not.toContain('shhh');
  });

  it('has() is false and get() is null for an absent key', () => {
    const store = createSecretStore(dir, fakeCryptor());
    expect(store.has('missing')).toBe(false);
    expect(store.get('missing')).toBeNull();
  });

  it('delete() removes the secret and is idempotent', () => {
    const store = createSecretStore(dir, fakeCryptor());
    store.set('api_key', 'shhh');
    store.delete('api_key');
    expect(store.has('api_key')).toBe(false);
    expect(() => store.delete('api_key')).not.toThrow();
  });

  it('rejects an illegal key with INVALID_PARAMS before touching disk', () => {
    const store = createSecretStore(dir, fakeCryptor());
    expect(codeOf(() => store.set('../escape', 'x'))).toBe('INVALID_PARAMS');
    expect(codeOf(() => store.has('a/b'))).toBe('INVALID_PARAMS');
  });

  it('refuses to store when OS encryption is unavailable (PRECONDITION_FAILED)', () => {
    const store = createSecretStore(dir, fakeCryptor(false));
    expect(store.isAvailable()).toBe(false);
    expect(codeOf(() => store.set('api_key', 'x'))).toBe('PRECONDITION_FAILED');
  });

  // An in-place write that dies half-way leaves ciphertext `get()` cannot decrypt, which reads as
  // "no key" — the stored secret is lost with no error. The rename is the commit point, so failing
  // it simulates a crash or a full disk after the new bytes were written.
  it('keeps the previous secret when a write fails before it commits', () => {
    const store = createSecretStore(dir, fakeCryptor());
    store.set('api_key', 'original');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    });
    expect(() => store.set('api_key', 'replacement')).toThrow(/ENOSPC/);
    vi.restoreAllMocks();
    expect(store.get('api_key')).toBe('original');
    // No stray temp beside it, and nothing on disk ever held the plaintext.
    expect(fs.readdirSync(dir)).toEqual(['api_key.enc']);
  });

  it('returns null when a stored blob cannot be decrypted', () => {
    const store = createSecretStore(dir, fakeCryptor());
    fs.writeFileSync(path.join(dir, 'api_key.enc'), Buffer.from('garbage'));
    expect(store.get('api_key')).toBeNull();
  });
});
