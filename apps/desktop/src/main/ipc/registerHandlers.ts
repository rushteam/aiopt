// The one place every IPC handler is wired into the Electron registry.
//
// Called once after `ready`, before the window loads, so the renderer's first
// calls always find a handler. Each subsystem contributes its own
// `register*Ipc(registry, …)`; the trusted-sender check + error sanitization
// live in the Electron adapter (ipc/registry.ts).

import { promises as fsp } from 'node:fs';
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { createElectronIpcRegistry } from './registry';
import { broadcastToRenderers } from './broadcast';
import { registerConfigIpc } from '../config/configIpc';
import { registerSecretIpc } from '../secrets/secretIpc';
import { registerAppInfoIpc } from '../app/appInfoIpc';
import { registerAuthIpc } from '../auth/authIpc';
import { registerUpdateIpc } from '../update/updateIpc';
import { registerProviderIpc } from '../providers/providerIpc';
import { registerOAuthProviderIpc } from '../oauth/oauthIpc';
import { registerAgentImportIpc } from '../agentImport/agentImportIpc';
import { registerUsageIpc } from '../usage/usageIpc';
import { registerSessionsIpc } from '../sessions/sessionsIpc';
import { registerSkillsIpc } from '../skills/skillsIpc';
import { registerMcpIpc } from '../mcp/mcpIpc';
import { registerWorkbenchIpc } from '../workbench/workbenchIpc';
import { rebuildAppMenuLabels } from '../menu/appMenu';
import { rebuildTrayLabels } from '../tray/tray';
import { installThemeSyncChannel } from '../config/themeSyncChannel';
import { installAppQuitChannel } from '../app/appQuitChannel';
import {
  registerAppShortcutIpc,
  installAppShortcutSyncChannels,
} from '../app-shortcuts/appShortcutIpc';
import {
  getAppShortcutStore,
  getAppVersions,
  getAuthManager,
  getConfigStore,
  getOAuthManager,
  getProviderManager,
  getSecretStore,
  getSkillsStore,
  getUpdateService,
  getUsageStore,
  getAgentSessionStore,
  getMcpStore,
  getMcpGateway,
  shutdownMcpGateway,
  getWorkbenchManager,
} from '../services';

export function registerHandlers(): void {
  const registry = createElectronIpcRegistry(ipcMain);
  registerConfigIpc(registry, getConfigStore(), broadcastToRenderers, {
    // Flipping proxy mode re-applies every binding so each moves between its direct
    // config and the loopback route (the change broadcast already refreshed the UI).
    onProxyModeChange: () => getProviderManager().rebuildProxyRoutes(),
    // The renderer relabels from the broadcast; the native menu and tray are main-side
    // and must be rebuilt explicitly or they keep the old language until relaunch.
    onLanguageChange: () => {
      rebuildAppMenuLabels();
      rebuildTrayLabels();
    },
    onExperimentalModeChange: () => rebuildTrayLabels(),
    // Off stops every gateway session and child; on serves on the next request.
    onMcpGatewayChange: (on) => {
      if (on) getMcpGateway().refresh();
      else void shutdownMcpGateway();
    },
  });
  registerSecretIpc(registry, getSecretStore());
  registerAppInfoIpc(registry, getAppVersions);
  registerAuthIpc(registry, getAuthManager());
  registerUpdateIpc(registry, getUpdateService());
  const providers = getProviderManager();
  registerProviderIpc(registry, providers, {
    // `file` is resolved MAIN-side by the manager from the agent-config allowlist; the
    // renderer names the file by (agentId, role) and never supplies a path. showItemInFolder
    // (not openPath) so the OS selects the file in its folder — AiOpt never reads it.
    revealItem: (file: string) => shell.showItemInFolder(file),
  });
  registerOAuthProviderIpc(registry, getOAuthManager(), providers);
  registerAgentImportIpc(registry, providers);
  registerUsageIpc(registry, getUsageStore());
  registerSessionsIpc(registry, getAgentSessionStore(), {
    writeClipboard: (text) => clipboard.writeText(text),
    // The export target is chosen here in main via a native save dialog — never supplied
    // by the renderer.
    pickSavePath: async (defaultName) => {
      const parent = BrowserWindow.getFocusedWindow() ?? undefined;
      const options = { defaultPath: defaultName, filters: [{ name: 'Markdown', extensions: ['md'] }] };
      const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    writeFile: (file, text) => fsp.writeFile(file, text, 'utf8'),
    platform: process.platform,
  });
  registerMcpIpc(registry, getMcpStore());
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
  registerWorkbenchIpc(registry, getWorkbenchManager(), {
    // The folder an agent may work in is chosen here in main via a native picker — never
    // supplied by the renderer.
    pickFolder: async () => {
      const parent = BrowserWindow.getFocusedWindow() ?? undefined;
      const options = { properties: ['openDirectory' as const, 'createDirectory' as const] };
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
  });
  const appShortcutStore = getAppShortcutStore();
  registerAppShortcutIpc(registry, appShortcutStore);
  // Synchronous first-paint theme read (its own ipcMain.on, not registry-based).
  installThemeSyncChannel();
  // One-way "quit the app" send for the in-app menu (raw ipcMain.on, sender-checked).
  installAppQuitChannel();
  // Raw app-shortcut channels: synchronous overrides read + the recording gate.
  installAppShortcutSyncChannels(appShortcutStore, process.platform);
  // Restore any persisted session in the background; the state-change broadcast
  // brings signed-in windows up to date once it resolves.
  void getAuthManager().initialize();
}
