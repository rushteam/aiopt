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

/** Side effects a preference change may require beyond persisting + broadcasting. */
export interface ConfigIpcHooks {
  /**
   * Called after `proxyMode` is set or reset, with its new effective value. The provider
   * manager re-applies every binding so each moves between its direct config and the
   * loopback route. Best-effort: a failure here must not fail the preference write.
   */
  onProxyModeChange?: (proxyMode: boolean) => void;
  /**
   * Called after `language` is set or reset. The renderer relabels itself from the
   * `config:changed` broadcast, but the NATIVE menu and tray are built in main and read
   * the preference only when built — so without this they keep the old language until
   * the next launch. Best-effort, same as above.
   */
  onLanguageChange?: () => void;
}

export function registerConfigIpc(
  registry: IpcHandlerRegistry,
  store: ConfigStore,
  broadcast: BroadcastFn,
  hooks: ConfigIpcHooks = {},
): void {
  // After a write that changed `proxyMode`, run its side effect (rebind all agents).
  const reactToProxyMode = (next: PreferencesShape): void => {
    if (!hooks.onProxyModeChange) return;
    try {
      hooks.onProxyModeChange(next.proxyMode);
    } catch {
      // Rebinding is best-effort; the preference is already persisted and broadcast.
    }
  };

  // After a write that changed `language`, relabel the native menu + tray.
  const reactToLanguage = (): void => {
    if (!hooks.onLanguageChange) return;
    try {
      hooks.onLanguageChange();
    } catch {
      // Relabelling is best-effort; the preference is already persisted and broadcast.
    }
  };

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
    if (key === 'proxyMode') reactToProxyMode(next);
    if (key === 'language') reactToLanguage();
    return next;
  });

  registry.register(IPC_CHANNELS.configReset, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const key = requireEnum(obj.key, PREFERENCE_KEYS, 'key');
    const next: PreferencesShape = store.reset(key);
    broadcast(IPC_EVENTS.configChanged, next);
    if (key === 'proxyMode') reactToProxyMode(next);
    if (key === 'language') reactToLanguage();
    return next;
  });
}
