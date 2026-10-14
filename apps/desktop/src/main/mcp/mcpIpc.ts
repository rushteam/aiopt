// MCP IPC. Authorize the sender FIRST, then validate, then act. The confirmation dialog for
// writes lives inside the store's injected `confirmWrite`, so no renderer path reaches an
// agent file without a human answering a native dialog (see mcpConfirm.ts).

import type { IpcHandlerRegistry } from '../ipc/registry';
import { requireEnum, requireObject, requireString, throwIpcError } from '../ipc/validate';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { MCP_AGENT_IDS, isMcpName } from '../../shared/mcp';
import { validateSaveRequest, type McpStore } from './mcpStore';

function requireName(value: unknown): string {
  const name = requireString(value, 'name');
  if (!isMcpName(name)) throwIpcError('INVALID_PARAMS', 'invalid server name');
  return name;
}

export function registerMcpIpc(registry: IpcHandlerRegistry, store: McpStore): void {
  registry.register(IPC_CHANNELS.mcpGet, (_payload, meta) => {
    meta.assertTrustedSender();
    return store.snapshot();
  });

  registry.register(IPC_CHANNELS.mcpSave, (payload, meta) => {
    meta.assertTrustedSender();
    return store.save(validateSaveRequest(payload));
  });

  registry.register(IPC_CHANNELS.mcpToggle, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const name = requireName(obj.name);
    const agentId = requireEnum(obj.agentId, MCP_AGENT_IDS, 'agentId');
    if (typeof obj.enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'enabled must be a boolean');
    return store.toggle(name, agentId, obj.enabled);
  });

  registry.register(IPC_CHANNELS.mcpResync, (payload, meta) => {
    meta.assertTrustedSender();
    return store.resync(requireName(requireObject(payload).name));
  });

  registry.register(IPC_CHANNELS.mcpDelete, (payload, meta) => {
    meta.assertTrustedSender();
    return store.remove(requireName(requireObject(payload).name));
  });

  registry.register(IPC_CHANNELS.mcpImport, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const agentId = requireEnum(obj.agentId, MCP_AGENT_IDS, 'agentId');
    return store.import(agentId, requireName(obj.name));
  });
}
