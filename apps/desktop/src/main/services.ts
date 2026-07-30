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
import { createAuthManager, type AuthManager } from './auth/authManager';
import { createLocalStubAuthProvider } from './auth/localStubAuthProvider';
import { createUpdateService, type UpdateService } from './update/updateService';
import { createLocalStubUpdateProvider } from './update/localStubUpdateProvider';
import { AppShortcutStore } from './app-shortcuts/AppShortcutStore';
import { broadcastAppShortcutChange } from './app-shortcuts/appShortcutIpc';
import { broadcastToRenderers } from './ipc/broadcast';
import { appShortcutsFilePath, preferencesFilePath, secretsDir } from './paths';
import { IPC_EVENTS, type AppVersionsResult } from '../shared/ipc-channels';

let configStore: ConfigStore | null = null;
let secretStore: SecretStore | null = null;
let authManager: AuthManager | null = null;
let updateService: UpdateService | null = null;
let appShortcutStore: AppShortcutStore | null = null;

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

export function getAuthManager(): AuthManager {
  if (!authManager) {
    authManager = createAuthManager(
      createLocalStubAuthProvider(),
      getSecretStore(),
      // Announce every session change to all windows (safe state only, no token).
      (state) => broadcastToRenderers(IPC_EVENTS.authStateChanged, state),
    );
  }
  return authManager;
}

export function getUpdateService(): UpdateService {
  if (!updateService) {
    updateService = createUpdateService(
      createLocalStubUpdateProvider(),
      () => app.getVersion(),
      (status) => broadcastToRenderers(IPC_EVENTS.updateStatusChanged, status),
    );
  }
  return updateService;
}

export function getAppShortcutStore(): AppShortcutStore {
  if (!appShortcutStore) {
    appShortcutStore = new AppShortcutStore({
      getFilePath: appShortcutsFilePath,
      platform: process.platform,
      // Propagate every rebind to all windows (override diff only, never secret).
      onChanged: (overrides) => broadcastAppShortcutChange(overrides),
    });
  }
  return appShortcutStore;
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
