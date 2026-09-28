import type { IpcHandlerRegistry } from '../ipc/registry';
import { requireEnum, requireObject } from '../ipc/validate';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import {
  AGENT_IMPORT_AGENT_IDS,
  type AgentImportCandidate,
} from '../../shared/agentImport';
import type { ProviderManager } from '../providers/providerManager';

/** Plain objects for structured clone — omit optional fields when unset. */
function wireAgentImportCandidates(list: AgentImportCandidate[]): AgentImportCandidate[] {
  return list.map((c) => {
    const row: AgentImportCandidate = {
      agentId: c.agentId,
      agentName: c.agentName,
      available: c.available,
      accountLabel: c.accountLabel,
    };
    if (c.reason !== undefined) row.reason = c.reason;
    return row;
  });
}

export function registerAgentImportIpc(registry: IpcHandlerRegistry, manager: ProviderManager): void {
  registry.register(IPC_CHANNELS.providersAgentImportScan, (_payload, meta) => {
    meta.assertTrustedSender();
    return { candidates: wireAgentImportCandidates(manager.scanAgentImports()) };
  });

  registry.register(IPC_CHANNELS.providersAgentImportAdd, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const agentId = requireEnum(obj.agentId, AGENT_IMPORT_AGENT_IDS, 'agentId');
    return manager.addAgentImportProvider(agentId);
  });
}
