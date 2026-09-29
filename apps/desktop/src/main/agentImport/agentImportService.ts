import { getAgentDef, type AgentId } from '../../shared/aiProviders';
import {
  AGENT_IMPORT_AGENT_IDS,
  type AgentImportAgentId,
  type AgentImportCandidate,
  isAgentImportAgentId,
} from '../../shared/agentImport';
import { AGENT_IMPORT_PROVIDER_TEMPLATES } from '../../shared/agentImportTemplates';
import { agentConfigDir } from '../providers/agentPaths';
import fs from 'node:fs';
import {
  claudeCredentialsFileExists,
  claudeSessionSnapshot,
  readClaudeAccessToken,
  readClaudeAccessTokenSync,
} from './claudeSession';
import {
  codexAuthFileExists,
  codexSessionSnapshot,
  readCodexAccessToken,
  readCodexAccessTokenSync,
} from './codexSession';
import {
  copilotInstallDirExists,
  copilotSessionSnapshot,
  readCopilotAccessTokenSync,
} from './copilotSession';

export type AgentImportFetch = (url: string, init?: RequestInit) => Promise<Response>;

function agentInstalled(agentId: AgentImportAgentId): boolean {
  if (agentId === 'copilot') return copilotInstallDirExists();
  try {
    return fs.existsSync(agentConfigDir(agentId));
  } catch {
    return false;
  }
}

export function scanAgentImportCandidates(): AgentImportCandidate[] {
  return AGENT_IMPORT_AGENT_IDS.map((agentId) => {
    const def = getAgentDef(agentId);
    const agentName = def?.name ?? agentId;
    if (!agentInstalled(agentId)) {
      return { agentId, agentName, available: false, accountLabel: null, reason: 'not_installed' };
    }
    if (agentId === 'codex') {
      if (!codexAuthFileExists()) {
        return { agentId, agentName, available: false, accountLabel: null, reason: 'not_signed_in' };
      }
      const snap = codexSessionSnapshot();
      return {
        agentId,
        agentName,
        available: snap.available,
        accountLabel: snap.accountLabel,
        reason: snap.available ? undefined : 'not_signed_in',
      };
    }
    if (agentId === 'claude') {
      if (!claudeCredentialsFileExists()) {
        return {
          agentId,
          agentName,
          available: false,
          accountLabel: null,
          reason: 'not_signed_in',
        };
      }
      const snap = claudeSessionSnapshot();
      return {
        agentId,
        agentName,
        available: snap.available,
        accountLabel: snap.accountLabel,
        reason: snap.available ? undefined : 'not_signed_in',
      };
    }
    if (agentId === 'copilot') {
      const snap = copilotSessionSnapshot();
      return {
        agentId,
        agentName,
        available: snap.available,
        accountLabel: snap.accountLabel,
        reason: snap.available ? undefined : 'not_signed_in',
      };
    }
    return { agentId, agentName, available: false, accountLabel: null, reason: 'unsupported' };
  });
}

export function agentImportSessionAvailable(agentId: AgentImportAgentId): boolean {
  const hit = scanAgentImportCandidates().find((c) => c.agentId === agentId);
  return hit?.available ?? false;
}

export function readAgentImportAccessTokenSync(agentId: AgentImportAgentId): string | null {
  if (agentId === 'codex') return readCodexAccessTokenSync();
  if (agentId === 'claude') return readClaudeAccessTokenSync();
  if (agentId === 'copilot') return readCopilotAccessTokenSync();
  return null;
}

export async function readAgentImportAccessToken(
  agentId: AgentImportAgentId,
  fetchImpl: AgentImportFetch,
): Promise<string | null> {
  if (agentId === 'codex') return readCodexAccessToken(fetchImpl);
  if (agentId === 'claude') return readClaudeAccessToken(fetchImpl);
  if (agentId === 'copilot') return readCopilotAccessTokenSync();
  return null;
}

export function templateForAgentImport(agentId: AgentImportAgentId) {
  return AGENT_IMPORT_PROVIDER_TEMPLATES[agentId];
}

export function parseAgentImportAgentId(value: unknown): AgentImportAgentId | null {
  return isAgentImportAgentId(value) ? value : null;
}

export function agentImportLabel(agentId: AgentId): string | null {
  if (!isAgentImportAgentId(agentId)) return null;
  const snap = scanAgentImportCandidates().find((c) => c.agentId === agentId);
  return snap?.accountLabel ?? null;
}
