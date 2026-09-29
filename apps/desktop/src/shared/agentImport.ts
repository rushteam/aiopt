// Agent credential import — shared types only (no I/O).
//
// Providers with `credentialMode: 'agent_import'` read tokens from an installed
// agent's on-disk (or future: OS keychain) session at request time. Tokens are not
// copied into AiOpt's secret store.

import { getAgentDef, type AgentId } from './aiProviders';

/** Agents AiOpt can import a subscription/API session from. */
export const AGENT_IMPORT_AGENT_IDS = ['codex', 'claude', 'copilot'] as const;

export type AgentImportAgentId = (typeof AGENT_IMPORT_AGENT_IDS)[number];

export function isAgentImportAgentId(value: unknown): value is AgentImportAgentId {
  return typeof value === 'string' && (AGENT_IMPORT_AGENT_IDS as readonly string[]).includes(value);
}

/** Persisted on the provider — which agent session to read. */
export interface AgentImportConfig {
  agentId: AgentImportAgentId;
}

/** One importable session the scan IPC may surface (no secrets). */
export interface AgentImportCandidate {
  agentId: AgentImportAgentId;
  /** Human label from {@link AGENT_SPECS} name. */
  agentName: string;
  /** Whether a usable session was found. */
  available: boolean;
  accountLabel: string | null;
  /** Why import is unavailable when `available` is false. */
  reason?: 'not_installed' | 'not_signed_in' | 'unsupported';
}

/** UI fallback when scan IPC is unavailable — always lists known import agents. */
export function placeholderAgentImportCandidates(): AgentImportCandidate[] {
  return AGENT_IMPORT_AGENT_IDS.map((agentId) => ({
    agentId,
    agentName: getAgentDef(agentId)?.name ?? agentId,
    available: false,
    accountLabel: null,
    reason: 'not_installed' as const,
  }));
}
