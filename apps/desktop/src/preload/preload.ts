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
  type AppVersionsResult,
  type PreferencesShape,
} from '../shared/ipc-channels';
import { isMenuCommand, type MenuCommand } from '../shared/menuCommands';

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

  /** Read the app/runtime version strings for the About page. */
  getVersions: (): Promise<AppVersionsResult> => ipcRenderer.invoke(IPC_CHANNELS.appGetVersions),

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

export type HearthBridge = typeof api;

contextBridge.exposeInMainWorld('hearth', api);
