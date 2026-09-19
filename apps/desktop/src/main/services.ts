// App services — lazily-built main-process singletons (config store, secret
// store). Kept separate from the IPC wiring so the stores can be constructed
// once and shared by handlers, the menu, and lifecycle code.
//
// Electron is touched ONLY here (paths + safeStorage); the stores themselves are
// Electron-free and unit-tested with injected adapters.

import { app, clipboard, net, safeStorage } from 'electron';
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
import {
  createProviderStore,
  createFileProviderPersistence,
} from './providers/providerStore';
import { createProviderManager, type ProviderManager } from './providers/providerManager';
import { createAdapterRegistry } from './providers/adapters/registry';
import { createTranslationProxy, type TranslationProxy } from './proxy/translationProxy';
import { createProxyStateStore, createFileProxyStatePersistence } from './proxy/proxyStore';
import type { ProxyFetch } from './proxy/upstream';
import { createUsageStore, createFileUsagePersistence, type UsageStore } from './usage/usageStore';
import { createSkillsStore, type SkillsStore } from './skills/skillsStore';
import { createNodeSkillsFs } from './skills/skillsFs';
import {
  appShortcutsFilePath,
  preferencesFilePath,
  providersFilePath,
  proxyStateFilePath,
  secretsDir,
  skillsLibraryPath,
  usageHistoryFilePath,
} from './paths';
import { IPC_EVENTS, type AppVersionsResult } from '../shared/ipc-channels';

let configStore: ConfigStore | null = null;
let secretStore: SecretStore | null = null;
let authManager: AuthManager | null = null;
let updateService: UpdateService | null = null;
let appShortcutStore: AppShortcutStore | null = null;
let providerManager: ProviderManager | null = null;
let translationProxy: TranslationProxy | null = null;
let usageStore: UsageStore | null = null;
let skillsStore: SkillsStore | null = null;

/**
 * Leading + trailing throttle: fire immediately, then at most once per `waitMs`. Used to
 * coalesce a burst of usage records into one broadcast so a busy proxy can't flood every
 * window with `usage:changed` events.
 */
function throttle(fn: () => void, waitMs: number): () => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  return () => {
    const elapsed = Date.now() - last;
    if (elapsed >= waitMs) {
      last = Date.now();
      fn();
    } else {
      pending = true;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          if (pending) {
            pending = false;
            last = Date.now();
            fn();
          }
        }, waitMs - elapsed);
      }
    }
  };
}

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

export function getProviderManager(): ProviderManager {
  if (!providerManager) {
    providerManager = createProviderManager(
      createProviderStore(createFileProviderPersistence(providersFilePath())),
      getSecretStore(),
      createAdapterRegistry(),
      // Announce every pool/binding change to all windows (safe snapshot, no key).
      (snapshot) => broadcastToRenderers(IPC_EVENTS.providersChanged, snapshot),
      // Lazy thunk to the translation proxy for cross-format bindings (breaks the
      // manager⇄proxy construction cycle; resolved via the singleton below).
      () => getTranslationProxy(),
      // Read the live "proxy mode" preference at each (re)bind: off (default) writes
      // same-format bindings direct; on routes them through the proxy for usage counting.
      () => getConfigStore().get('proxyMode'),
      // Model discovery uses Electron's net stack (honors system proxy / certs).
      (url, init) => net.fetch(url, init),
      // Copy-proxy-config writes the (token-bearing) snippet straight to the OS clipboard,
      // main-side, so the token never crosses IPC back to the renderer.
      (text) => clipboard.writeText(text),
    );
  }
  return providerManager;
}

/**
 * The cross-format translation proxy — a loopback HTTP server that lets an agent
 * speaking one wire format bind to a provider speaking another. Its outbound transport
 * is Electron's `net.fetch` (streaming; honors system proxy / certs); its key resolver
 * routes through providerManager so the plaintext key is read in exactly one place. Its
 * identity (fixed port + per-binding tokens) is persisted under `userData/proxy.json` so
 * a restart reuses the loopback address a running agent already cached.
 */
export function getTranslationProxy(): TranslationProxy {
  if (!translationProxy) {
    // net.fetch is WHATWG-fetch-shaped; its Response structurally satisfies
    // ProxyFetchResponse (ok/status/headers.get/body/text). Cast bridges the init types.
    const fetchImpl = ((url, init) => net.fetch(url, init as RequestInit)) as ProxyFetch;
    translationProxy = createTranslationProxy({
      fetchImpl,
      getKey: (providerId) => getProviderManager().resolveUpstreamKey(providerId),
      // Record every upstream attempt (counts + ids only) for the statistics view.
      recordUsage: (event) => getUsageStore().record(event),
      // Persist the port + route tokens so they survive a restart (see proxyStore.ts).
      persistence: createProxyStateStore(createFileProxyStatePersistence(proxyStateFilePath())),
    });
  }
  return translationProxy;
}

/**
 * The usage-statistics store — the main-process sink for proxy-recorded usage. Persists an
 * append-only JSONL log under userData (counts + identifiers only; no content/keys/tokens)
 * and broadcasts a throttled `usage:changed` snapshot so an open statistics view stays live.
 */
export function getUsageStore(): UsageStore {
  if (!usageStore) {
    const store = createUsageStore(createFileUsagePersistence(usageHistoryFilePath()));
    const broadcast = throttle(() => broadcastToRenderers(IPC_EVENTS.usageChanged, store.snapshot()), 1000);
    store.onChange(broadcast);
    usageStore = store;
  }
  return usageStore;
}

/**
 * The skills store — AiOpt as the central library for skills scattered across each agent's
 * global skills dir. It has NO persistence file of its own: the skill DIRECTORIES on disk are
 * the source of truth, and every path is resolved main-side from base dirs it holds (the central
 * library path from the `skillsLibrary` enum preference; the user's home for agent dirs) — the
 * renderer never supplies a path. A throttled `skills:changed` snapshot keeps an open Skills view
 * live after a pull/push/import/delete.
 */
export function getSkillsStore(): SkillsStore {
  if (!skillsStore) {
    const homeDir = app.getPath('home');
    const store = createSkillsStore({
      fs: createNodeSkillsFs(),
      homeDir,
      getLibraryLocation: () => getConfigStore().get('skillsLibrary'),
      centralDirFor: (location) => skillsLibraryPath(location),
      // Shorten a home-rooted path to `~/…` for display (metadata only; no file contents).
      displayPath: (abs) => (abs === homeDir ? '~' : abs.startsWith(`${homeDir}/`) ? `~${abs.slice(homeDir.length)}` : abs),
    });
    const broadcast = throttle(() => broadcastToRenderers(IPC_EVENTS.skillsChanged, store.snapshot()), 1000);
    store.onChange(broadcast);
    skillsStore = store;
  }
  return skillsStore;
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
