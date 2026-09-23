// Preload — the minimal-privilege bridge. Expose only purpose-named methods via
// contextBridge; NEVER expose raw ipcRenderer or a channel-choosing function.
// See docs/dev-rules/electron-security-and-process-boundaries.md §4.
//
// Each method is a single named action with explicit argument/return types that
// maps to one allowlisted channel, and every event subscription drops the raw
// IpcRendererEvent before anything reaches the renderer.

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  IPC_SEND_CHANNELS,
  IPC_SYNC_CHANNELS,
  type AppShortcutsChangedEvent,
  type AppShortcutsGetResult,
  type AppShortcutsMutationResult,
  type AppVersionsResult,
  type AuthState,
  type PreferencesShape,
  type ProviderAddRequest,
  type ProviderFetchModelsRequest,
  type ProviderCopyProxyConfigResult,
  type ProviderRefreshProxyPortResult,
  type ProviderFetchModelsResult,
  type ProviderRevealKeyResult,
  type ProviderUpdateRequest,
  type ProvidersSnapshot,
  type SkillsImportResult,
  type ThemePreference,
  type UpdateStatus,
} from '../shared/ipc-channels';
import type {
  SkillDiffResult,
  SkillFileContent,
  SkillRevealRef,
  SkillScope,
  SkillsSnapshot,
} from '../shared/skills';
import type { UsageSnapshot } from '../shared/usageStats';
import type { AppShortcutCombo, AppShortcutId } from '../shared/appShortcuts';
import type { AgentId } from '../shared/aiProviders';
import { isMenuCommand, type MenuCommand } from '../shared/menuCommands';
import { applyThemeVariables } from '../renderer/themes/tokens';

/** Read the stored theme preference synchronously (used for first-paint only). */
function initialThemePreference(): ThemePreference {
  const value = ipcRenderer.sendSync(IPC_SYNC_CHANNELS.themeGet);
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

// Anti-flash: before the document paints, apply the stored theme's token values
// (resolving `system` against the OS) via the CSSOM. The renderer's ThemeProvider
// takes over reactively once React mounts.
window.addEventListener('DOMContentLoaded', () => {
  try {
    const pref = initialThemePreference();
    const prefersDark =
      typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = pref === 'dark' || (pref === 'system' && prefersDark) ? 'dark' : 'light';
    applyThemeVariables(resolved);
  } catch {
    // Leave the CSS default in place if the read fails.
  }
});

/** Subscribe to a push channel, stripping the Electron event; returns an unsubscribe fn. */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  platform: process.platform,
  // Electron/Chrome/Node versions are safe to surface for a diagnostics footer.
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  /** Layered user preferences (defaults + overrides; reads are the effective snapshot). */
  config: {
    getAll: (): Promise<PreferencesShape> => ipcRenderer.invoke(IPC_CHANNELS.configGetAll),
    set: <K extends keyof PreferencesShape>(
      key: K,
      value: PreferencesShape[K],
    ): Promise<PreferencesShape> => ipcRenderer.invoke(IPC_CHANNELS.configSet, { key, value }),
    reset: (key: keyof PreferencesShape): Promise<PreferencesShape> =>
      ipcRenderer.invoke(IPC_CHANNELS.configReset, { key }),
    /** Subscribe to preference changes pushed from main; returns an unsubscribe fn. */
    onChanged: (callback: (prefs: PreferencesShape) => void): (() => void) =>
      subscribe(IPC_EVENTS.configChanged, callback),
  },

  /**
   * OS-encrypted secret store. The renderer can store / check / clear a secret,
   * but can NEVER read its plaintext back — decryption is main-only.
   */
  secret: {
    set: (key: string, value: string): Promise<Record<string, never>> =>
      ipcRenderer.invoke(IPC_CHANNELS.secretSet, { key, value }),
    has: (key: string): Promise<{ present: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.secretHas, { key }),
    delete: (key: string): Promise<Record<string, never>> =>
      ipcRenderer.invoke(IPC_CHANNELS.secretDelete, { key }),
  },

  /** Theme preference: read the initial value synchronously; write via config.set. */
  theme: {
    getInitial: (): ThemePreference => initialThemePreference(),
  },

  /**
   * Auth session. The renderer drives login/logout and observes the SAFE state
   * (status + user identity) — the session token stays in main and is never
   * returned here.
   */
  auth: {
    getState: (): Promise<AuthState> => ipcRenderer.invoke(IPC_CHANNELS.authGetState),
    login: (username: string, password: string): Promise<AuthState> =>
      ipcRenderer.invoke(IPC_CHANNELS.authLogin, { username, password }),
    logout: (): Promise<AuthState> => ipcRenderer.invoke(IPC_CHANNELS.authLogout),
    /** Subscribe to session changes pushed from main; returns an unsubscribe fn. */
    onStateChanged: (callback: (state: AuthState) => void): (() => void) =>
      subscribe(IPC_EVENTS.authStateChanged, callback),
  },

  /**
   * App updates. The bundled stub always reports up-to-date; a real feed is a
   * gated, high-risk change (see docs/dev-rules/updater.md).
   */
  update: {
    getStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC_CHANNELS.updateGetStatus),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC_CHANNELS.updateCheck),
    /** Subscribe to status changes pushed from main; returns an unsubscribe fn. */
    onStatusChanged: (callback: (status: UpdateStatus) => void): (() => void) =>
      subscribe(IPC_EVENTS.updateStatusChanged, callback),
  },

  /**
   * User-rebindable keyboard shortcuts. The renderer reads the current overrides
   * synchronously (so its store is populated on first render), writes rebinds
   * through main (which re-validates every write), and toggles the recording gate
   * while capturing a keystroke. Only the OVERRIDE diff crosses the bridge; the
   * default table lives in shared/appShortcuts and resolves identically here.
   */
  appShortcuts: {
    /** Synchronous initial read: persisted overrides + platform. */
    getState: (): AppShortcutsGetResult => {
      const value = ipcRenderer.sendSync(IPC_SYNC_CHANNELS.appShortcutsGet) as unknown;
      if (value && typeof value === 'object' && 'overrides' in value && 'platform' in value) {
        return value as AppShortcutsGetResult;
      }
      return { overrides: {}, platform: process.platform };
    },
    /** Rebind one shortcut (`combo: null` disables it). Rejected combos throw a coded error. */
    setOverride: (
      id: AppShortcutId,
      combo: AppShortcutCombo | null,
    ): Promise<AppShortcutsMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.appShortcutsSetOverride, { id, combo }),
    /** Reset one shortcut to its default (delete its override). */
    clearOverride: (id: AppShortcutId): Promise<AppShortcutsMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.appShortcutsClearOverride, { id }),
    /** Reset all shortcuts to defaults (clear every override). */
    resetAll: (): Promise<AppShortcutsMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.appShortcutsResetAll),
    /** Tell main the settings page started / stopped capturing a keystroke. */
    setRecording: (recording: boolean): void =>
      ipcRenderer.send(IPC_SEND_CHANNELS.appShortcutsSetRecording, { recording }),
    /** Subscribe to override changes pushed from main; returns an unsubscribe fn. */
    onChanged: (callback: (event: AppShortcutsChangedEvent) => void): (() => void) =>
      subscribe(IPC_EVENTS.appShortcutsChanged, callback),
  },

  /**
   * AI providers. Manage the global provider pool and bind each agent to a
   * provider+model. An API key can be SENT here (add/update) to be stored
   * encrypted main-side, but is NEVER returned — reads carry only `hasKey`.
   */
  providers: {
    list: (): Promise<ProvidersSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.providersList),
    add: (input: ProviderAddRequest): Promise<ProvidersSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersAdd, input),
    update: (input: ProviderUpdateRequest): Promise<ProvidersSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersUpdate, input),
    remove: (id: string): Promise<ProvidersSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersRemove, { id }),
    setBinding: (agentId: AgentId, providerId: string, modelId: string): Promise<ProvidersSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersSetBinding, { agentId, providerId, modelId }),
    clearBinding: (agentId: AgentId): Promise<ProvidersSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersClearBinding, { agentId }),
    /** Undo an agent's takeover: restore its native config to pre-AiOpt and clear the binding. */
    restoreDefault: (agentId: AgentId): Promise<ProvidersSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersRestoreDefault, { agentId }),
    /**
     * Ask a provider's API for its available models. The key is resolved main-side
     * (from the request or an existing provider) and never returned — only models.
     */
    fetchModels: (input: ProviderFetchModelsRequest): Promise<ProviderFetchModelsResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersFetchModels, input),
    /**
     * GATED: fetch a provider's stored key in PLAINTEXT for viewing. Unlike every
     * sibling here, this returns the secret (see the channel note). Callers must hold
     * it transiently — never persist or log it.
     */
    revealKey: (providerId: string): Promise<ProviderRevealKeyResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersRevealKey, { providerId }),
    /**
     * Copy a proxied agent's loopback config (OpenAI/Anthropic-compatible base URL + token)
     * to the clipboard. The token is written to the clipboard main-side and NEVER returned
     * here — the result carries only whether a live route existed to copy.
     */
    copyProxyConfig: (agentId: AgentId): Promise<ProviderCopyProxyConfigResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersCopyProxyConfig, { agentId }),
    /**
     * Move the loopback proxy to a fresh port and re-sync every proxied agent's on-disk
     * config to it (the escape hatch for a port collision). Returns the new port; the fresh
     * snapshot arrives via the `providers:changed` push.
     */
    refreshProxyPort: (): Promise<ProviderRefreshProxyPortResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersRefreshProxyPort),
    /**
     * Open one of an agent's managed config files in the OS file manager, so the user can
     * read the RAW file in their own editor. Named by (agentId, role) — NOT a path: main
     * resolves it through the agent-config allowlist. This is deliberately the only route to
     * raw config content: those files hold plaintext secrets, which must never cross here.
     */
    revealConfig: (agentId: AgentId, role: string): Promise<Record<string, never>> =>
      ipcRenderer.invoke(IPC_CHANNELS.providersRevealConfig, { agentId, role }),
    /** Subscribe to pool/binding changes pushed from main; returns an unsubscribe fn. */
    onChanged: (callback: (snapshot: ProvidersSnapshot) => void): (() => void) =>
      subscribe(IPC_EVENTS.providersChanged, callback),
  },

  /**
   * Usage statistics of proxied cross-format traffic. Read the aggregated snapshot,
   * clear the history, or subscribe to live changes. Carries only counts + identifiers
   * — never content, keys, or token plaintext.
   */
  usage: {
    get: (): Promise<UsageSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.usageGet),
    clear: (): Promise<UsageSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.usageClear),
    /** Subscribe to usage changes pushed from main; returns an unsubscribe fn. */
    onChanged: (callback: (snapshot: UsageSnapshot) => void): (() => void) =>
      subscribe(IPC_EVENTS.usageChanged, callback),
  },

  /**
   * Skills sync. AiOpt is the central library; these methods discover skills across
   * each agent's global skills dir and move them in/out. A skill is named ONLY by
   * symbolic coordinates (agentId + validated name) — never a path. `import` opens a
   * folder picker in MAIN (the source path is never supplied here); `reveal` opens a
   * store-resolved, allowlisted directory in the OS file manager.
   */
  skills: {
    get: (): Promise<SkillsSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.skillsGet),
    /** Pull an agent's copy into the central library (agent → central). */
    pull: (agentId: AgentId, name: string): Promise<SkillsSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.skillsPull, { agentId, name }),
    /** Push the central copy out to one or more agents (central → agents). */
    push: (name: string, agentIds: AgentId[]): Promise<SkillsSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.skillsPush, { name, agentIds }),
    /** Import a folder (chosen via a main-side picker) as a skill into the central library. */
    import: (): Promise<SkillsImportResult> => ipcRenderer.invoke(IPC_CHANNELS.skillsImport),
    /** Delete a skill from the central library (destructive; the caller confirms first). */
    delete: (name: string): Promise<SkillsSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.skillsDelete, { name }),
    /** Delete an agent's own copy of a skill (destructive; the caller confirms first). */
    deleteAgent: (agentId: AgentId, name: string): Promise<SkillsSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.skillsDeleteAgent, { agentId, name }),
    /** Per-file diff of an agent's copy against the central copy (metadata only). */
    diff: (agentId: AgentId, name: string): Promise<SkillDiffResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.skillsDiff, { agentId, name }),
    /** Read one differing file's content (from a side) for the diff preview; text/size-capped. */
    fileContent: (
      agentId: AgentId,
      name: string,
      side: SkillScope,
      relPath: string,
    ): Promise<SkillFileContent> =>
      ipcRenderer.invoke(IPC_CHANNELS.skillsFileContent, { agentId, name, side, relPath }),
    /** Merge a differing skill back into the central library, taking the picked files from the agent. */
    merge: (agentId: AgentId, name: string, agentPicks: string[]): Promise<SkillsSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.skillsMerge, { agentId, name, agentPicks }),
    /** Open a skills location (central library or an agent dir, optionally one skill) in the file manager. */
    reveal: (ref: SkillRevealRef): Promise<Record<string, never>> =>
      ipcRenderer.invoke(IPC_CHANNELS.skillsReveal, ref),
    /** Subscribe to sync-matrix changes pushed from main; returns an unsubscribe fn. */
    onChanged: (callback: (snapshot: SkillsSnapshot) => void): (() => void) =>
      subscribe(IPC_EVENTS.skillsChanged, callback),
  },

  /** Read the app/runtime version strings for the About page. */
  getVersions: (): Promise<AppVersionsResult> => ipcRenderer.invoke(IPC_CHANNELS.appGetVersions),

  /**
   * Quit the whole app (the in-app menu's "Quit"). One-way send; main asserts the
   * trusted sender, then calls `app.quit()`. Needed because on macOS closing the
   * window only hides it to the tray — this is the explicit path to a real exit.
   */
  quit: (): void => ipcRenderer.send(IPC_SEND_CHANNELS.appQuit),

  /**
   * Subscribe to native application-menu commands. The payload is re-validated
   * against the command allowlist here — a push carrying anything else is
   * dropped, so the renderer only ever sees a known `MenuCommand`. Returns an
   * unsubscribe fn.
   */
  onMenuCommand: (callback: (command: MenuCommand) => void): (() => void) =>
    subscribe<unknown>(IPC_EVENTS.menuCommand, (raw) => {
      if (isMenuCommand(raw)) callback(raw);
    }),
} as const;

export type AiOptBridge = typeof api;

contextBridge.exposeInMainWorld('aiopt', api);
