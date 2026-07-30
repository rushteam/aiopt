// Config IPC — exposes the layered preference store to the renderer.
//
// Every handler follows the same shape: authorize the sender FIRST, then
// validate the payload at runtime, then touch the store. Writes broadcast the
// new effective snapshot so every window stays in sync. See the security rule §5.

import type { IpcHandlerRegistry } from '../ipc/registry';
import { requireEnum, requireObject } from '../ipc/validate';
import { IPC_CHANNELS, IPC_EVENTS } from '../../shared/ipc-channels';
import type { PreferencesShape } from '../../shared/ipc-channels';
import type { ConfigStore } from './configStore';
import { PREFERENCE_KEYS } from './configStore';

/** Push the new effective preferences to renderers after a change. */
export type BroadcastFn = (channel: string, payload: unknown) => void;

export function registerConfigIpc(
  registry: IpcHandlerRegistry,
  store: ConfigStore,
  broadcast: BroadcastFn,
): void {
  registry.register(IPC_CHANNELS.configGetAll, (_payload, meta) => {
    meta.assertTrustedSender();
    return store.getEffective();
  });

  registry.register(IPC_CHANNELS.configSet, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const key = requireEnum(obj.key, PREFERENCE_KEYS, 'key');
    // Value validation is delegated to the store's per-key validator.
    const next: PreferencesShape = store.set(key, obj.value);
    broadcast(IPC_EVENTS.configChanged, next);
    return next;
  });

  registry.register(IPC_CHANNELS.configReset, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const key = requireEnum(obj.key, PREFERENCE_KEYS, 'key');
    const next: PreferencesShape = store.reset(key);
    broadcast(IPC_EVENTS.configChanged, next);
    return next;
  });
}
