// App services — lazily-built main-process singletons (config store, secret
// store). Kept separate from the IPC wiring so the stores can be constructed
// once and shared by handlers, the menu, and lifecycle code.
//
// Electron is touched ONLY here (paths + safeStorage); the stores themselves are
// Electron-free and unit-tested with injected adapters.

import fs from 'node:fs';
import { BrowserWindow, app, clipboard, dialog, net, safeStorage } from 'electron';
import {
  createConfigStore,
  createFilePreferencePersistence,
  type ConfigStore,
} from './config/configStore';
import { createSecretStore, type SecretCryptor, type SecretStore } from './secrets/secretStore';
import { createAuthManager, type AuthManager } from './auth/authManager';
import { createLocalStubAuthProvider } from './auth/localStubAuthProvider';
import { createUpdateService, type UpdateService } from './update/updateService';
import { createGithubReleaseUpdateProvider } from './update/githubReleaseUpdateProvider';
import { AppShortcutStore } from './app-shortcuts/AppShortcutStore';
import { broadcastAppShortcutChange } from './app-shortcuts/appShortcutIpc';
import { broadcastToRenderers } from './ipc/broadcast';
import {
  createProviderStore,
  createFileProviderPersistence,
  type ProviderStore,
} from './providers/providerStore';
import { createProviderManager, type ProviderManager } from './providers/providerManager';
import {
  createBindingAppliedStore,
  createFileBindingAppliedPersistence,
  type BindingAppliedStore,
} from './providers/bindingAppliedStore';
import {
  createBindingProfileStore,
  createFileBindingProfilePersistence,
  type BindingProfileStore,
} from './providers/bindingProfileStore';
import { createOAuthManager, type OAuthManager } from './oauth/oauthManager';
import { createAdapterRegistry } from './providers/adapters/registry';
import { createTranslationProxy, type TranslationProxy } from './proxy/translationProxy';
import { createProxyStateStore, createFileProxyStatePersistence } from './proxy/proxyStore';
import type { ProxyFetch } from './proxy/upstream';
import { createUpstreamRegistry, type UpstreamRegistry } from './upstreams/types';
import { createCursorClient } from './upstreams/cursor/client';
import { createCursorDriver } from './upstreams/cursor/driver';
import { cursorAccessToken, cursorClientVersion } from './upstreams/cursor/agentCli';
import { createUsageStore, createFileUsagePersistence, type UsageStore } from './usage/usageStore';
import { createAgentSessionStore, type AgentSessionStore } from './sessions/agentSessionStore';
import { createMcpStore, type McpStore } from './mcp/mcpStore';
import { buildMcpConfirm, buildMcpGatewayConfirm } from './mcp/mcpConfirm';
import { createMcpGateway, GATEWAY_PATH, type McpGateway } from './mcp/mcpGateway';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomBytes } from 'node:crypto';
import { candidateBinDirs } from './workbench/herdrCli';
import { resolveMenuLocaleForPreference } from './menu/menuLabels';
import { homeShortenedPath } from './providers/agentConfigView';
import { agentConfigDir, agentHome } from './providers/agentPaths';
import { createSkillsStore, type SkillsStore } from './skills/skillsStore';
import { createNodeSkillsFs } from './skills/skillsFs';
import { isRealDirectory } from './skills/skillsLibraryDir';
import { preferStandardSkillsLibrary } from '../shared/skills';
import { homeRelativeDisplayPath } from './displayPath';
import { createWorkbenchManager, type WorkbenchManager } from './workbench/workbenchManager';
import { syncWorkbenchTrayHint } from './tray/tray';
import { createNodeWorkbenchDeps } from './workbench/nodeDeps';
import { resolveWorkbenchModel } from './workbench/resolveModel';
import { logger } from './logger';
import {
  appShortcutsFilePath,
  preferencesFilePath,
  providersFilePath,
  bindingProfilesFilePath,
  bindingAppliedFilePath,
  proxyStateFilePath,
  secretsDir,
  skillsLibraryPath,
  usageHistoryFilePath,
  workbenchDir,
  mcpServersFilePath,
} from './paths';
import { IPC_EVENTS, type AppVersionsResult } from '../shared/ipc-channels';

let configStore: ConfigStore | null = null;
let secretStore: SecretStore | null = null;
let authManager: AuthManager | null = null;
let updateService: UpdateService | null = null;
let appShortcutStore: AppShortcutStore | null = null;
let providerStore: ProviderStore | null = null;
let oauthManager: OAuthManager | null = null;
let providerManager: ProviderManager | null = null;
let translationProxy: TranslationProxy | null = null;
let usageStore: UsageStore | null = null;
let agentSessionStore: AgentSessionStore | null = null;
let mcpStore: McpStore | null = null;
let mcpGateway: McpGateway | null = null;
let gatewayToken: string | null = null;
let skillsStore: SkillsStore | null = null;
let workbenchManager: WorkbenchManager | null = null;
let upstreamRegistry: UpstreamRegistry | null = null;

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
      // Check-only: compares the running version with the newest published GitHub
      // Release. It never downloads or installs. See docs/dev-rules/updater.md.
      createGithubReleaseUpdateProvider((url, init) => net.fetch(url, init)),
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

function getProviderStore(): ProviderStore {
  if (!providerStore) {
    providerStore = createProviderStore(createFileProviderPersistence(providersFilePath()));
  }
  return providerStore;
}

let bindingProfileStore: BindingProfileStore | null = null;
let bindingAppliedStore: BindingAppliedStore | null = null;

function getBindingProfileStore(): BindingProfileStore {
  if (!bindingProfileStore) {
    bindingProfileStore = createBindingProfileStore(
      createFileBindingProfilePersistence(bindingProfilesFilePath()),
    );
  }
  return bindingProfileStore;
}

function getBindingAppliedStore(): BindingAppliedStore {
  if (!bindingAppliedStore) {
    bindingAppliedStore = createBindingAppliedStore(
      createFileBindingAppliedPersistence(bindingAppliedFilePath()),
    );
  }
  return bindingAppliedStore;
}

export function getOAuthManager(): OAuthManager {
  if (!oauthManager) {
    oauthManager = createOAuthManager({
      store: getProviderStore(),
      secrets: getSecretStore(),
      fetchImpl: (url, init) => net.fetch(url, init),
      onProvidersChanged: () => {
        if (providerManager) {
          broadcastToRenderers(IPC_EVENTS.providersChanged, providerManager.getSnapshot());
        }
      },
    });
  }
  return oauthManager;
}

/**
 * The upstream drivers (main/upstreams/): providers served by a private protocol rather
 * than an HTTP POST. The list is fixed at build time — drivers are never loaded at runtime
 * (docs/dev-rules/upstream-drivers.md). Add a driver here.
 */
function getUpstreamRegistry(): UpstreamRegistry {
  if (!upstreamRegistry) {
    const fetchImpl = ((url, init) => net.fetch(url, init as RequestInit)) as ProxyFetch;
    upstreamRegistry = createUpstreamRegistry([
      // Signed-in cursor-agent (agent import). Unary calls over net.fetch; Run over node:http2.
      createCursorDriver({
        client: createCursorClient({ fetchImpl, clientVersion: cursorClientVersion }),
        token: cursorAccessToken,
      }),
    ]);
  }
  return upstreamRegistry;
}

export function getProviderManager(): ProviderManager {
  if (!providerManager) {
    providerManager = createProviderManager(
      getProviderStore(),
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
      getOAuthManager(),
      getBindingProfileStore(),
      getBindingAppliedStore(),
      // Config profiles also record which MCP servers each agent has enabled.
      {
        capture: () => getMcpStore().enabledSets(),
        plan: (sets) => getMcpStore().planEnabledSets(sets),
      },
      // Driver-served providers list models / are tested through their driver.
      (provider) => getUpstreamRegistry().forProvider(provider),
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
      // Per-provider fields to strip from the outbound body (see proxy/sanitize.ts) —
      // resolved live, like the key, so a provider edit needs no rebind.
      getDropFields: (providerId) => getProviderManager().resolveDropFields(providerId),
      // Prompt-cache breakpoints for Anthropic upstreams (see proxy/promptCache.ts), live.
      getPromptCache: () => getConfigStore().get('promptCache'),
      // Record every upstream attempt (counts + ids only) for the statistics view.
      recordUsage: (event) => getUsageStore().record(event),
      // Persist the port + route tokens so they survive a restart (see proxyStore.ts).
      persistence: createProxyStateStore(createFileProxyStatePersistence(proxyStateFilePath())),
      // A driver-served provider is answered by its driver, not an HTTP POST (live lookup).
      upstreamFor: (providerId) => getUpstreamRegistry().forProvider(getProviderStore().getProvider(providerId)),
      // The opt-in MCP gateway shares this loopback listener under its own path token.
      gateway: {
        token: () => (getConfigStore().get('mcpGateway') ? getGatewayToken() : null),
        handle: (req, res, rest) => getMcpGateway().handle(req, res, rest),
      },
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
 * Read-only scanner over the agents' own session logs (Claude Code / Codex JSONL under the
 * agent home). Serves the local-usage view and the sessions reader; writes nothing.
 */
export function getAgentSessionStore(): AgentSessionStore {
  if (!agentSessionStore) agentSessionStore = createAgentSessionStore({ home: agentHome });
  return agentSessionStore;
}

/** Secret-store key of the gateway's path token (main-only; cannot collide with `main_mcp_<hex>`). */
const GATEWAY_TOKEN_SECRET = 'main_mcp_gateway_token';

/**
 * The gateway's path token: persisted in the secret store so agent entries survive a
 * restart, or memory-only (re-add after restart) when encryption is unavailable. Never logged.
 */
function getGatewayToken(): string {
  if (gatewayToken) return gatewayToken;
  const secrets = getSecretStore();
  const stored = secrets.isAvailable() ? secrets.get(GATEWAY_TOKEN_SECRET) : null;
  if (stored && /^[A-Za-z0-9_-]{32,128}$/.test(stored)) {
    gatewayToken = stored;
  } else {
    gatewayToken = `mcp-${randomBytes(24).toString('base64url')}`;
    if (secrets.isAvailable()) {
      try {
        secrets.set(GATEWAY_TOKEN_SECRET, gatewayToken);
      } catch {
        // Memory-only for this run; agent entries just show `stale` after a restart.
      }
    }
  }
  return gatewayToken;
}

/** Native confirmation shown by main before a server is served through the MCP gateway. */
async function showNativeConfirm(c: { title: string; message: string; detail: string; confirm: string; cancel: string }): Promise<boolean> {
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: [c.cancel, c.confirm],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: c.title,
    message: c.message,
    detail: c.detail,
  };
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const { response } =
    parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  return response === 1;
}

/**
 * The opt-in MCP gateway (docs/dev-rules/mcp-gateway.md). Built lazily; serves only servers
 * confirmed for it, and only while the `mcpGateway` preference is on.
 */
export function getMcpGateway(): McpGateway {
  if (!mcpGateway) {
    mcpGateway = createMcpGateway({
      enabled: () => getConfigStore().get('mcpGateway'),
      servers: () => getMcpStore().gatewayServers(),
      port: () => getTranslationProxy().getPort(),
      childEnv: () => {
        const env = getDefaultEnvironment();
        // A Finder launch has a minimal PATH; add the usual install dirs (npx, uvx, docker).
        env.PATH = candidateBinDirs(process.env.PATH, agentHome()).join(':');
        return env;
      },
      childCwd: () => agentHome(),
      version: app.getVersion(),
    });
  }
  return mcpGateway;
}

/** Stop the gateway's sessions and upstream children (gateway off, or quit). Best-effort. */
export async function shutdownMcpGateway(): Promise<void> {
  if (mcpGateway) await mcpGateway.stop();
}

/**
 * The MCP library. `confirmWrite` is a NATIVE dialog shown by main — the one gate between a
 * renderer request and a command landing in an agent config (see main/mcp/mcpConfirm.ts).
 * Cancel is the default and the Escape answer.
 */
export function getMcpStore(): McpStore {
  if (!mcpStore) {
    mcpStore = createMcpStore({
      filePath: mcpServersFilePath(),
      secrets: getSecretStore(),
      isInstalled: (agentId) => fs.existsSync(agentConfigDir(agentId)),
      displayPath: homeShortenedPath,
      confirmWrite: async (reqs) => {
        const locale = resolveMenuLocaleForPreference(getConfigStore().get('language'), app.getLocale());
        const c = buildMcpConfirm(locale, reqs);
        const opts: Electron.MessageBoxOptions = {
          type: 'warning',
          buttons: [c.cancel, c.confirm],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: c.title,
          message: c.message,
          detail: c.detail,
        };
        const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const { response } =
          parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
        return response === 1;
      },
      confirmGateway: (req) => {
        const locale = resolveMenuLocaleForPreference(getConfigStore().get('language'), app.getLocale());
        return showNativeConfirm(buildMcpGatewayConfirm(locale, req));
      },
      onLibraryChange: () => mcpGateway?.refresh(),
      gateway: {
        enabled: () => getConfigStore().get('mcpGateway'),
        url: () => {
          const port = getTranslationProxy().getPort();
          return port > 0 ? `http://127.0.0.1:${port}/${getGatewayToken()}${GATEWAY_PATH}` : null;
        },
        status: () => (mcpGateway ? mcpGateway.status() : {}),
      },
    });
  }
  return mcpStore;
}

/**
 * First open of Skills, when the user has never chosen a library: if the in-app
 * library is empty and `~/.agents/skills` already exists, record that choice.
 * Does not create the directory, and does not move a library that already has skills.
 */
function adoptStandardLibraryIfUnset(): void {
  const config = getConfigStore();
  const choice = preferStandardSkillsLibrary({
    hasOverride: Object.prototype.hasOwnProperty.call(config.getOverrides(), 'skillsLibrary'),
    appHasSkills: createNodeSkillsFs().listSkillNames(skillsLibraryPath('app')).length > 0,
    standardDirExists: isRealDirectory(skillsLibraryPath('agents')),
  });
  if (choice) config.set('skillsLibrary', choice);
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
    adoptStandardLibraryIfUnset();
    const homeDir = app.getPath('home');
    const store = createSkillsStore({
      fs: createNodeSkillsFs(),
      homeDir,
      getLibraryLocation: () => getConfigStore().get('skillsLibrary'),
      centralDirFor: (location) => skillsLibraryPath(location),
      // Shorten a home-rooted path to `~/…` for display (metadata only; no file contents).
      // Same helper the agent config panel uses, so the two surfaces cannot drift again.
      displayPath: (abs) => homeRelativeDisplayPath(abs, homeDir),
    });
    const broadcast = throttle(() => broadcastToRenderers(IPC_EVENTS.skillsChanged, store.snapshot()), 1000);
    store.onChange(broadcast);
    skillsStore = store;
  }
  return skillsStore;
}

/**
 * The workbench — a chat orchestrator (headless pi) that proposes tasks, and pi workers in
 * AiOpt's own herdr session that run the ones the user approves. It follows pi's binding on
 * the Providers screen for its model; the credential goes to its child processes by
 * environment only. A throttled `workbench:changed` snapshot keeps the view live while the
 * orchestrator streams.
 */
export function getWorkbenchManager(): WorkbenchManager {
  if (!workbenchManager) {
    let manager: WorkbenchManager | null = null;
    const broadcast = throttle(() => {
      if (!manager) return;
      const snap = manager.getSnapshot();
      broadcastToRenderers(IPC_EVENTS.workbenchChanged, snap);
      syncWorkbenchTrayHint(snap);
    }, 150);
    manager = createWorkbenchManager({
      ...createNodeWorkbenchDeps(),
      platform: process.platform,
      arch: process.arch,
      dataDir: workbenchDir(),
      homeDir: app.getPath('home'),
      env: process.env,
      resolveModel: () =>
        resolveWorkbenchModel({
          snapshot: () => getProviderManager().getSnapshot(),
          endpointFor: (agentId) => getTranslationProxy().endpointFor(agentId),
          resolveUpstreamKey: (providerId) => getProviderManager().resolveUpstreamKey(providerId),
        }),
      onChange: broadcast,
      logger: logger.child('workbench'),
      // @session mentions in the coordinator chat: read-only, named by (agentId, sessionId).
      readSession: (ref) => getAgentSessionStore().transcript(ref),
    });
    workbenchManager = manager;
    syncWorkbenchTrayHint(manager.getSnapshot());
  }
  return workbenchManager;
}

/** Tear the workbench down on quit, only if it was ever built. */
export function shutdownWorkbench(): void {
  workbenchManager?.shutdown();
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
