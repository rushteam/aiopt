import type { IpcHandlerRegistry } from '../ipc/registry';
import { requireObject, requireString } from '../ipc/validate';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { OAuthManager } from './oauthManager';
import type { ProviderManager } from '../providers/providerManager';

export function registerOAuthProviderIpc(
  registry: IpcHandlerRegistry,
  oauth: OAuthManager,
  manager: ProviderManager,
): void {
  registry.register(IPC_CHANNELS.providersOAuthStart, async (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const providerId = requireString(obj.providerId, 'providerId');
    await oauth.startLogin(providerId);
    return manager.getSnapshot();
  });

  registry.register(IPC_CHANNELS.providersOAuthDisconnect, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const providerId = requireString(obj.providerId, 'providerId');
    oauth.disconnect(providerId);
    return manager.getSnapshot();
  });
}
