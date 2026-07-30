// App-info IPC — read-only version strings for the About page.
//
// No side effects and no secrets, but it still authorizes the sender first: the
// authorization check is uniform across every channel, never conditional on how
// "sensitive" a handler looks. The version source is injected so the handler is
// Electron-free and unit-testable.

import type { IpcHandlerRegistry } from '../ipc/registry';
import { IPC_CHANNELS, type AppVersionsResult } from '../../shared/ipc-channels';

export type AppVersionsProvider = () => AppVersionsResult;

export function registerAppInfoIpc(
  registry: IpcHandlerRegistry,
  getVersions: AppVersionsProvider,
): void {
  registry.register(IPC_CHANNELS.appGetVersions, (_payload, meta) => {
    meta.assertTrustedSender();
    return getVersions();
  });
}
