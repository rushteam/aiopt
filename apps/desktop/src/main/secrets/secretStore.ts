// Secret store — the OS-encrypted-credential primitive.
//
// Secrets (auth tokens, API keys) are encrypted with the OS keychain / DPAPI via
// Electron `safeStorage` and written as `<key>.enc` files under a dedicated
// directory in `userData` (see main/paths.ts). Credentials must NEVER be written
// to a git-tracked path, and plaintext is NEVER returned across IPC to the
// renderer — decryption is main-only. See
// docs/dev-rules/credentials-and-local-storage.md.
//
// The store is Electron-free: the OS cryptor is injected, so a fake cryptor lets
// the key-validation + persistence logic unit-test without a running app.

import fs from 'node:fs';
import path from 'node:path';
import { throwIpcError } from '../ipc/validate';

// Storage keys become `.enc` FILE NAMES, so they must not contain path
// separators or `.` — a key like `../../evil` would escape the secrets dir.
const SAFE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/** Keys with this prefix are main-only; the renderer secret IPC refuses them. */
export const MAIN_ONLY_SECRET_PREFIX = 'main_';

export function assertSafeSecretKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !SAFE_KEY_RE.test(key)) {
    throwIpcError('INVALID_PARAMS', 'secret key must match /^[A-Za-z0-9_-]+$/');
  }
}

/**
 * Whether the generic renderer-facing secret IPC may touch this key. Main-only
 * credentials (e.g. the auth token) are written by main and off-limits to the
 * renderer, which never gets their plaintext regardless.
 */
export function isRendererAccessibleSecretKey(key: string): boolean {
  return !key.startsWith(MAIN_ONLY_SECRET_PREFIX);
}

/** The OS-backed cryptor. Production passes Electron `safeStorage`; tests fake it. */
export interface SecretCryptor {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

export interface SecretStore {
  isAvailable(): boolean;
  set(key: string, plaintext: string): void;
  /** MAIN-ONLY plaintext read. Never surface this across IPC to the renderer. */
  get(key: string): string | null;
  has(key: string): boolean;
  delete(key: string): void;
}

export function createSecretStore(dir: string, cryptor: SecretCryptor): SecretStore {
  function fileFor(key: string): string {
    assertSafeSecretKey(key);
    return path.join(dir, `${key}.enc`);
  }

  return {
    isAvailable: () => cryptor.isEncryptionAvailable(),

    set(key, plaintext) {
      const file = fileFor(key);
      if (typeof plaintext !== 'string') {
        throwIpcError('INVALID_PARAMS', 'secret value must be a string');
      }
      if (!cryptor.isEncryptionAvailable()) {
        throwIpcError('PRECONDITION_FAILED', 'OS secret encryption is unavailable');
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, cryptor.encryptString(plaintext));
    },

    get(key) {
      const file = fileFor(key);
      try {
        return cryptor.decryptString(fs.readFileSync(file));
      } catch {
        // Missing file or undecryptable blob → treat as absent.
        return null;
      }
    },

    has(key) {
      return fs.existsSync(fileFor(key));
    },

    delete(key) {
      try {
        fs.rmSync(fileFor(key));
      } catch {
        // Already gone.
      }
    },
  };
}
