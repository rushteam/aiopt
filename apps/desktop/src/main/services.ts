// App services — lazily-built main-process singletons (config store, secret
// store). Kept separate from the IPC wiring so the stores can be constructed
// once and shared by handlers, the menu, and lifecycle code.
//
// Electron is touched ONLY here (paths + safeStorage); the stores themselves are
// Electron-free and unit-tested with injected adapters.

import { app, safeStorage } from 'electron';
import {
  createConfigStore,
  createFilePreferencePersistence,
  type ConfigStore,
} from './config/configStore';
import { createSecretStore, type SecretCryptor, type SecretStore } from './secrets/secretStore';
import { preferencesFilePath, secretsDir } from './paths';
import type { AppVersionsResult } from '../shared/ipc-channels';

let configStore: ConfigStore | null = null;
let secretStore: SecretStore | null = null;

export function getConfigStore(): ConfigStore {
  if (!configStore) {
    configStore = createConfigStore(createFilePreferencePersistence(preferencesFilePath()));
  }
  return configStore;
}

/** Electron `safeStorage` adapted to the injectable SecretCryptor shape. */
const electronCryptor: SecretCryptor = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plaintext) => safeStorage.encryptString(plaintext),
  decryptString: (ciphertext) => safeStorage.decryptString(ciphertext),
};

export function getSecretStore(): SecretStore {
  if (!secretStore) {
    secretStore = createSecretStore(secretsDir(), electronCryptor);
  }
  return secretStore;
}

/** The version strings shown on the About page. */
export function getAppVersions(): AppVersionsResult {
  return {
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  };
}
