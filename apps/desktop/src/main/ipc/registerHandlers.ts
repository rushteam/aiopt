// The one place every IPC handler is wired into the Electron registry.
//
// Called once after `ready`, before the window loads, so the renderer's first
// calls always find a handler. Each subsystem contributes its own
// `register*Ipc(registry, …)`; the trusted-sender check + error sanitization
// live in the Electron adapter (ipc/registry.ts).

import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { createElectronIpcRegistry } from './registry';
import { broadcastToRenderers } from './broadcast';
import { registerConfigIpc } from '../config/configIpc';
import { registerSecretIpc } from '../secrets/secretIpc';
import { registerAppInfoIpc } from '../app/appInfoIpc';
import { registerAuthIpc } from '../auth/authIpc';
import { registerUpdateIpc } from '../update/updateIpc';
import { registerProviderIpc } from '../providers/providerIpc';
import { registerUsageIpc } from '../usage/usageIpc';
import { registerSkillsIpc } from '../skills/skillsIpc';
import { installThemeSyncChannel } from '../config/themeSyncChannel';
import {
  registerAppShortcutIpc,
  installAppShortcutSyncChannels,
} from '../app-shortcuts/appShortcutIpc';
import {
  getAppShortcutStore,
  getAppVersions,
  getAuthManager,
  getConfigStore,
  getProviderManager,
  getSecretStore,
  getSkillsStore,
  getUpdateService,
  getUsageStore,
} from '../services';

export function registerHandlers(): void {
  const registry = createElectronIpcRegistry(ipcMain);
  registerConfigIpc(registry, getConfigStore(), broadcastToRenderers, {
    // Flipping proxy mode re-applies every binding so each moves between its direct
    // config and the loopback route (the change broadcast already refreshed the UI).
    onProxyModeChange: () => getProviderManager().rebuildProxyRoutes(),
  });
  registerSecretIpc(registry, getSecretStore());
  registerAppInfoIpc(registry, getAppVersions);
  registerAuthIpc(registry, getAuthManager());
  registerUpdateIpc(registry, getUpdateService());
  registerProviderIpc(registry, getProviderManager());
  registerUsageIpc(registry, getUsageStore());
  registerSkillsIpc(registry, getSkillsStore(), {
    // The import SOURCE is chosen here in main via a native picker — never supplied
    // by the renderer. A single directory; treated as one skill by the store.
    pickImportDir: async () => {
      const parent = BrowserWindow.getFocusedWindow() ?? undefined;
      const result = parent
        ? await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
    // `dir` is resolved main-side by the store to a contained skills/library dir.
    openPath: async (dir: string) => {
      await shell.openPath(dir);
    },
  });
  const appShortcutStore = getAppShortcutStore();
  registerAppShortcutIpc(registry, appShortcutStore);
  // Synchronous first-paint theme read (its own ipcMain.on, not registry-based).
  installThemeSyncChannel();
  // Raw app-shortcut channels: synchronous overrides read + the recording gate.
  installAppShortcutSyncChannels(appShortcutStore, process.platform);
  // Restore any persisted session in the background; the state-change broadcast
  // brings signed-in windows up to date once it resolves.
  void getAuthManager().initialize();
}
