// Preload — the minimal-privilege bridge. Expose only purpose-named methods via
// contextBridge; NEVER expose raw ipcRenderer or a channel-choosing function.
// See docs/dev-rules/electron-security-and-process-boundaries.md §4.
//
// Stage 1 exposes only static, non-privileged info to prove the bridge is wired.
// IPC-backed methods are added in the IPC-authorization stage — each one a single
// named action with explicit argument and return types, dropping the Electron
// event before anything reaches the renderer.

import { contextBridge } from 'electron';

const api = {
  platform: process.platform,
  // Electron/Chrome/Node versions are safe to surface for a diagnostics footer.
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
} as const;

export type HearthBridge = typeof api;

contextBridge.exposeInMainWorld('hearth', api);
