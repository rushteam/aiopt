// The one place every IPC handler is wired into the Electron registry.
//
// Called once after `ready`, before the window loads, so the renderer's first
// calls always find a handler. Each subsystem contributes its own
// `register*Ipc(registry, …)`; the trusted-sender check + error sanitization
// live in the Electron adapter (ipc/registry.ts).

import { ipcMain } from 'electron';
import { createElectronIpcRegistry } from './registry';
import { broadcastToRenderers } from './broadcast';
import { registerConfigIpc } from '../config/configIpc';
import { registerSecretIpc } from '../secrets/secretIpc';
import { getConfigStore, getSecretStore } from '../services';

export function registerHandlers(): void {
  const registry = createElectronIpcRegistry(ipcMain);
  registerConfigIpc(registry, getConfigStore(), broadcastToRenderers);
  registerSecretIpc(registry, getSecretStore());
}
