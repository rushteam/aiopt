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
import {
  cursorAuthFileExists,
  cursorSessionSnapshot,
  readCursorAccessTokenSync,
} from './cursorSession';
import {
  devinInstallDirExists,
  devinSessionSnapshot,
  readDevinAccessTokenSync,
} from './devinSession';
import {
  geminiOAuthCredsExist,
  geminiSessionSnapshot,
  readGeminiAccessToken,
  readGeminiAccessTokenSync,
} from './geminiSession';
import { dshInstallDirExists, dshSessionSnapshot, readDshAccessTokenSync } from './dshSession';
import {
  commandcodeInstallDirExists,
  commandcodeSessionSnapshot,
  readCommandCodeAccessTokenSync,
} from './commandcodeSession';
import { readZcodeAccessTokenSync, zcodeInstallDirExists, zcodeSessionSnapshot } from './zcodeSession';
import {
  readWorkBuddyAccessTokenSync,
  workbuddyInstallDirExists,
  workbuddySessionSnapshot,
} from './workbuddySession';
import { kiroInstallDirExists, kiroSessionSnapshot, readKiroAccessTokenSync } from './kiroSession';
import {
  grokInstallDirExists,
  grokSessionSnapshot,
  readGrokAccessTokenSync,
} from './grokSession';

export type AgentImportFetch = (url: string, init?: RequestInit) => Promise<Response>;

function agentInstalled(agentId: AgentImportAgentId): boolean {
  if (agentId === 'copilot') return copilotInstallDirExists();
  if (agentId === 'grok') return grokInstallDirExists();
  if (agentId === 'devin') return devinInstallDirExists();
  if (agentId === 'gemini') return geminiOAuthCredsExist();
  if (agentId === 'cursor') return cursorAuthFileExists();
  if (agentId === 'dsh') return dshInstallDirExists();
  if (agentId === 'commandcode') return commandcodeInstallDirExists();
  if (agentId === 'zcode') return zcodeInstallDirExists();
  if (agentId === 'workbuddy') return workbuddyInstallDirExists();
  if (agentId === 'kiro') return kiroInstallDirExists();
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
    if (agentId === 'grok') {
      const snap = grokSessionSnapshot();
      return {
        agentId,
        agentName,
        available: snap.available,
        accountLabel: snap.accountLabel,
        reason: snap.available ? undefined : 'not_signed_in',
      };
    }
    if (agentId === 'devin') {
      const snap = devinSessionSnapshot();
      return {
        agentId,
        agentName,
        available: snap.available,
        accountLabel: snap.accountLabel,
        reason: snap.available ? undefined : 'not_signed_in',
      };
    }
    if (agentId === 'gemini') {
      if (!geminiOAuthCredsExist()) {
        return {
          agentId,
          agentName,
          available: false,
          accountLabel: null,
          reason: 'not_signed_in',
        };
      }
      const snap = geminiSessionSnapshot();
      return {
        agentId,
        agentName,
        available: snap.available,
        accountLabel: snap.accountLabel,
        reason: snap.available ? undefined : 'not_signed_in',
      };
    }
    if (agentId === 'cursor') {
      const snap = cursorSessionSnapshot();
      return {
        agentId,
        agentName,
        available: snap.available,
        accountLabel: snap.accountLabel,
        reason: snap.available ? undefined : 'not_signed_in',
      };
    }
    if (agentId === 'dsh' || agentId === 'commandcode' || agentId === 'zcode' || agentId === 'workbuddy' || agentId === 'kiro') {
      const snap =
        agentId === 'dsh'
          ? dshSessionSnapshot()
          : agentId === 'commandcode'
            ? commandcodeSessionSnapshot()
            : agentId === 'zcode'
              ? zcodeSessionSnapshot()
              : agentId === 'workbuddy'
                ? workbuddySessionSnapshot()
                : kiroSessionSnapshot();
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
  if (agentId === 'grok') return readGrokAccessTokenSync();
  if (agentId === 'devin') return readDevinAccessTokenSync();
  if (agentId === 'gemini') return readGeminiAccessTokenSync();
  if (agentId === 'cursor') return readCursorAccessTokenSync();
  if (agentId === 'dsh') return readDshAccessTokenSync();
  if (agentId === 'commandcode') return readCommandCodeAccessTokenSync();
  if (agentId === 'zcode') return readZcodeAccessTokenSync();
  if (agentId === 'workbuddy') return readWorkBuddyAccessTokenSync();
  if (agentId === 'kiro') return readKiroAccessTokenSync();
  return null;
}

export async function readAgentImportAccessToken(
  agentId: AgentImportAgentId,
  fetchImpl: AgentImportFetch,
): Promise<string | null> {
  if (agentId === 'codex') return readCodexAccessToken(fetchImpl);
  if (agentId === 'claude') return readClaudeAccessToken(fetchImpl);
  if (agentId === 'copilot') return readCopilotAccessTokenSync();
  if (agentId === 'grok') return readGrokAccessTokenSync();
  if (agentId === 'devin') return readDevinAccessTokenSync();
  if (agentId === 'gemini') return readGeminiAccessToken(fetchImpl);
  if (agentId === 'cursor') return readCursorAccessTokenSync();
  if (agentId === 'dsh') return readDshAccessTokenSync();
  if (agentId === 'commandcode') return readCommandCodeAccessTokenSync();
  if (agentId === 'zcode') return readZcodeAccessTokenSync();
  if (agentId === 'workbuddy') return readWorkBuddyAccessTokenSync();
  if (agentId === 'kiro') return readKiroAccessTokenSync();
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
