// Provider IPC — the renderer-facing surface of the provider manager.
//
// Same shape as every handler: authorize the sender FIRST, then validate the
// payload at runtime, then touch the manager. Results are the SAFE
// `ProvidersSnapshot` (providers carry `hasKey`, never key plaintext). Broadcasting
// the change is the manager's job (via its onChange), so handlers just return the
// post-change snapshot. An API key may arrive on add/update to be stored, but no
// handler ever returns one. See the security rule §5.

import type { IpcHandlerRegistry } from '../ipc/registry';
import {
  optionalString,
  requireEnum,
  requireObject,
  requireString,
  throwIpcError,
} from '../ipc/validate';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { AGENT_IDS, API_FORMATS, type ProviderModel } from '../../shared/aiProviders';
import type { ProviderManager } from './providerManager';

/** Validate an untrusted models array: non-empty, each `{ id, alias? }` well-formed. */
function requireModels(raw: unknown): ProviderModel[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throwIpcError('INVALID_PARAMS', 'models must be a non-empty array');
  }
  return raw.map((entry, i) => {
    const obj = requireObject(entry, `models[${i}]`);
    const model: ProviderModel = { id: requireString(obj.id, `models[${i}].id`) };
    if (typeof obj.alias === 'string' && obj.alias.trim() !== '') model.alias = obj.alias.trim();
    return model;
  });
}

export function registerProviderIpc(registry: IpcHandlerRegistry, manager: ProviderManager): void {
  registry.register(IPC_CHANNELS.providersList, (_payload, meta) => {
    meta.assertTrustedSender();
    return manager.getSnapshot();
  });

  registry.register(IPC_CHANNELS.providersAdd, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    return manager.addProvider({
      name: requireString(obj.name, 'name'),
      apiFormat: requireEnum(obj.apiFormat, API_FORMATS, 'apiFormat'),
      baseUrl: requireString(obj.baseUrl, 'baseUrl'),
      models: requireModels(obj.models),
      notes: typeof obj.notes === 'string' ? obj.notes : undefined,
      apiKey: typeof obj.apiKey === 'string' && obj.apiKey !== '' ? obj.apiKey : undefined,
    });
  });

  registry.register(IPC_CHANNELS.providersUpdate, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    return manager.updateProvider({
      id: requireString(obj.id, 'id'),
      name: obj.name !== undefined ? requireString(obj.name, 'name') : undefined,
      apiFormat: obj.apiFormat !== undefined ? requireEnum(obj.apiFormat, API_FORMATS, 'apiFormat') : undefined,
      baseUrl: obj.baseUrl !== undefined ? requireString(obj.baseUrl, 'baseUrl') : undefined,
      models: obj.models !== undefined ? requireModels(obj.models) : undefined,
      notes: typeof obj.notes === 'string' ? obj.notes : undefined,
      // null clears the stored key; a string replaces it; omitted leaves it.
      apiKey: obj.apiKey === null ? null : typeof obj.apiKey === 'string' ? obj.apiKey : undefined,
    });
  });

  registry.register(IPC_CHANNELS.providersRemove, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    return manager.removeProvider(requireString(obj.id, 'id'));
  });

  registry.register(IPC_CHANNELS.providersSetBinding, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const agentId = requireEnum(obj.agentId, AGENT_IDS, 'agentId');
    const providerId = requireString(obj.providerId, 'providerId');
    const modelId = requireString(obj.modelId, 'modelId');
    return manager.setBinding(agentId, providerId, modelId);
  });

  registry.register(IPC_CHANNELS.providersClearBinding, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    return manager.clearBinding(requireEnum(obj.agentId, AGENT_IDS, 'agentId'));
  });

  registry.register(IPC_CHANNELS.providersRestoreDefault, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    return manager.restoreAgentDefault(requireEnum(obj.agentId, AGENT_IDS, 'agentId'));
  });

  registry.register(IPC_CHANNELS.providersFetchModels, async (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const models = await manager.fetchModels({
      apiFormat: requireEnum(obj.apiFormat, API_FORMATS, 'apiFormat'),
      baseUrl: requireString(obj.baseUrl, 'baseUrl'),
      apiKey: optionalString(obj.apiKey),
      providerId: optionalString(obj.providerId),
    });
    return { models };
  });

  // GATED: hands the stored key plaintext back to the renderer (see channel note).
  // Authorize first; the result intentionally carries the secret, so never log it.
  registry.register(IPC_CHANNELS.providersRevealKey, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    return { key: manager.revealKey(requireString(obj.providerId, 'providerId')) };
  });
}
