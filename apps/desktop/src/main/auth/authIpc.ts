// Auth IPC — the renderer-facing surface of the auth manager.
//
// Every handler authorizes the sender FIRST, then validates the payload. Results
// are the SAFE `AuthState` only — the session token never appears in a result or
// a broadcast (the manager keeps it in the secret store). Broadcasting the state
// change is the manager's job (via its onStateChange), so these handlers just
// return the post-transition state. See the security rule §5.

import type { IpcHandlerRegistry } from '../ipc/registry';
import { requireObject, requireString } from '../ipc/validate';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { AuthManager } from './authManager';

export function registerAuthIpc(registry: IpcHandlerRegistry, manager: AuthManager): void {
  registry.register(IPC_CHANNELS.authGetState, (_payload, meta) => {
    meta.assertTrustedSender();
    return manager.getState();
  });

  registry.register(IPC_CHANNELS.authLogin, async (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const username = requireString(obj.username, 'username');
    const password = requireString(obj.password, 'password');
    return manager.login({ username, password });
  });

  registry.register(IPC_CHANNELS.authLogout, async (_payload, meta) => {
    meta.assertTrustedSender();
    return manager.logout();
  });
}
