// Secret IPC — the renderer-facing surface of the secret store.
//
// The renderer may STORE, CHECK, and CLEAR a secret, but there is deliberately
// no channel that returns a secret's plaintext — decryption stays in main. Keys
// are validated (no path traversal) and main-only keys are refused. See the
// security rule §5 and docs/dev-rules/credentials-and-local-storage.md.

import type { IpcHandlerRegistry } from '../ipc/registry';
import { requireObject, requireString, throwIpcError } from '../ipc/validate';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { SecretStore } from './secretStore';
import { assertSafeSecretKey, isRendererAccessibleSecretKey } from './secretStore';

/** Validate a renderer-supplied secret key: well-formed AND renderer-accessible. */
function requireRendererSecretKey(raw: unknown): string {
  const key = requireString(raw, 'key');
  assertSafeSecretKey(key);
  if (!isRendererAccessibleSecretKey(key)) {
    throwIpcError('PERMISSION_DENIED', 'this secret key is managed by the app');
  }
  return key;
}

export function registerSecretIpc(registry: IpcHandlerRegistry, store: SecretStore): void {
  registry.register(IPC_CHANNELS.secretSet, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const key = requireRendererSecretKey(obj.key);
    const value = requireString(obj.value, 'value');
    store.set(key, value);
    return {};
  });

  registry.register(IPC_CHANNELS.secretHas, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const key = requireRendererSecretKey(obj.key);
    return { present: store.has(key) };
  });

  registry.register(IPC_CHANNELS.secretDelete, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const key = requireRendererSecretKey(obj.key);
    store.delete(key);
    return {};
  });
}
