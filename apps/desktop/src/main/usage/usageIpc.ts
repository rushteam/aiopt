// Usage IPC — the renderer-facing surface of the usage store.
//
// Same shape as every handler: authorize the sender FIRST, then touch the store.
// Both channels return the aggregated `UsageSnapshot` (counts + identifiers only,
// never content/keys/tokens). Broadcasting the change is the store's job (via its
// onChange, wired in services.ts), so these handlers just return the snapshot.

import type { IpcHandlerRegistry } from '../ipc/registry';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { UsageStore } from './usageStore';

export function registerUsageIpc(registry: IpcHandlerRegistry, store: UsageStore): void {
  registry.register(IPC_CHANNELS.usageGet, (_payload, meta) => {
    meta.assertTrustedSender();
    return store.snapshot();
  });

  registry.register(IPC_CHANNELS.usageClear, (_payload, meta) => {
    meta.assertTrustedSender();
    store.clear();
    return store.snapshot();
  });
}
