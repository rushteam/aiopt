// Update IPC — the renderer-facing surface of the update service.
//
// Both handlers authorize the sender first. Status broadcasting is the service's
// job (via its onStatusChange), so these handlers just return the current /
// post-check status. See the security rule §5.

import type { IpcHandlerRegistry } from '../ipc/registry';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { UpdateService } from './updateService';

export function registerUpdateIpc(registry: IpcHandlerRegistry, service: UpdateService): void {
  registry.register(IPC_CHANNELS.updateGetStatus, (_payload, meta) => {
    meta.assertTrustedSender();
    return service.getStatus();
  });

  registry.register(IPC_CHANNELS.updateCheck, async (_payload, meta) => {
    meta.assertTrustedSender();
    return service.check();
  });
}
