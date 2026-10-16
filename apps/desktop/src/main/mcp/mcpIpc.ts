// MCP IPC. Authorize the sender FIRST, then validate, then act. The confirmation dialog for
// a push lives inside the store's injected `confirmWrite`, so no renderer path puts a spec
// into an agent file without a human answering a native dialog (see mcpConfirm.ts). The
// renderer names servers and agents only; files are fixed in main.

import type { IpcHandlerRegistry } from '../ipc/registry';
import { requireEnum, requireObject, requireString, throwIpcError } from '../ipc/validate';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { MCP_AGENT_IDS, MCP_LIMITS, isMcpName, type McpAgentId } from '../../shared/mcp';
import { validateSaveRequest, type McpStore } from './mcpStore';

function requireName(value: unknown): string {
  const name = requireString(value, 'name');
  if (!isMcpName(name)) throwIpcError('INVALID_PARAMS', 'invalid server name');
  return name;
}

/** Field ids per server: the spec plus every env var / header. */
const MAX_PICKS = 1 + 2 * MCP_LIMITS.maxVars;

function requireAgentAndName(payload: unknown): { agentId: McpAgentId; name: string } {
  const obj = requireObject(payload);
  return { agentId: requireEnum(obj.agentId, MCP_AGENT_IDS, 'agentId'), name: requireName(obj.name) };
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

  registry.register(IPC_CHANNELS.mcpPull, (payload, meta) => {
    meta.assertTrustedSender();
    const { agentId, name } = requireAgentAndName(payload);
    return store.pull(agentId, name);
  });

  registry.register(IPC_CHANNELS.mcpPush, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const name = requireName(obj.name);
    if (!Array.isArray(obj.agentIds) || obj.agentIds.length === 0 || obj.agentIds.length > MCP_AGENT_IDS.length) {
      throwIpcError('INVALID_PARAMS', 'agentIds must be a non-empty array');
    }
    const agentIds = [...new Set(obj.agentIds.map((v, i) => requireEnum(v, MCP_AGENT_IDS, `agentIds[${i}]`)))];
    return store.push(name, agentIds);
  });

  registry.register(IPC_CHANNELS.mcpDelete, (payload, meta) => {
    meta.assertTrustedSender();
    return store.remove(requireName(requireObject(payload).name));
  });

  registry.register(IPC_CHANNELS.mcpDeleteAgent, (payload, meta) => {
    meta.assertTrustedSender();
    const { agentId, name } = requireAgentAndName(payload);
    return store.removeFromAgent(agentId, name);
  });

  registry.register(IPC_CHANNELS.mcpDiff, (payload, meta) => {
    meta.assertTrustedSender();
    const { agentId, name } = requireAgentAndName(payload);
    return store.diff(agentId, name);
  });

  // GATED: the one MCP channel whose result carries a secret value (see mcp-servers.md §2).
  registry.register(IPC_CHANNELS.mcpRevealValue, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const name = requireName(obj.name);
    const kind = requireEnum(obj.kind, ['env', 'header'] as const, 'kind');
    const key = requireString(obj.key, 'key');
    if (key.length === 0 || key.length > 200) throwIpcError('INVALID_PARAMS', 'invalid key');
    return { value: store.revealValue(name, kind, key) };
  });

  registry.register(IPC_CHANNELS.mcpMerge, (payload, meta) => {
    meta.assertTrustedSender();
    const { agentId, name } = requireAgentAndName(payload);
    const picks = requireObject(payload).agentPicks;
    if (!Array.isArray(picks) || picks.length > MAX_PICKS || picks.some((p) => typeof p !== 'string' || p.length > 200)) {
      throwIpcError('INVALID_PARAMS', 'agentPicks must be an array of field ids');
    }
    return store.merge(agentId, name, picks as string[]);
  });
}
