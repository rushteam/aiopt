// WorkBuddy adapter (additive).
//
// WorkBuddy (Tencent CodeBuddy) takes custom models from ~/.workbuddy/models.json:
// a list (or {"models":[…],"availableModels":[…]}) of OpenAI chat-completions models,
// each with {id, name, vendor, apiKey, url, supportsToolCall, supportsImages, …}.
//
// AiOpt appends its models (vendor "aiopt") and preserves the user's own entries.
// WorkBuddy watches the file and picks up changes without a restart.

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, wireModelName, type AgentDef } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { readJsonObject, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import type { LiveBindingSnapshot } from './bindingLive';

const DEF: AgentDef = getAgentDef('workbuddy')!;
const VENDOR = 'aiopt';

interface ModelEntry {
  id: string;
  name: string;
  vendor: string;
  apiKey: string;
  url: string;
  supportsToolCall: boolean;
  supportsImages: boolean;
  [key: string]: unknown;
}

function readModelsList(file: string): { models: ModelEntry[]; wrap: boolean } {
  let raw: unknown;
  try {
    const text = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
    raw = JSON.parse(text);
  } catch {
    return { models: [], wrap: false };
  }
  if (Array.isArray(raw)) return { models: raw as ModelEntry[], wrap: false };
  if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).models)) {
    return { models: (raw as Record<string, unknown>).models as ModelEntry[], wrap: true };
  }
  return { models: [], wrap: false };
}

export function createWorkBuddyAdapter(): AgentAdapter {
  return {
    def: DEF,

    configPaths() {
      return [resolveAgentFile(AGENT_FILES.workbuddy.models)];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('workbuddy'));
    },

    writeLive({ provider, apiKey }: WriteLiveInput) {
      const file = resolveAgentFile(AGENT_FILES.workbuddy.models);
      const { models, wrap } = readModelsList(file);

      // Preserve user's entries (those not from AiOpt).
      const userModels = models.filter((m) => m.vendor !== VENDOR);

      // Add AiOpt's models.
      const aioptModels: ModelEntry[] = provider.models.map((m) => {
        const wire = wireModelName(m);
        return {
          id: wire,
          name: wire,
          vendor: VENDOR,
          apiKey: apiKey ?? '',
          url: `${provider.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`,
          supportsToolCall: true,
          supportsImages: false,
        };
      });

      const combined = [...userModels, ...aioptModels];
      const output = wrap ? { models: combined, availableModels: combined } : combined;
      writeAgentConfigFile(file, `${JSON.stringify(output, null, 2)}\n`);
    },

    readLiveBinding(_applied: AppliedBindingRecord): LiveBindingSnapshot | null {
      const file = resolveAgentFile(AGENT_FILES.workbuddy.models);
      const { models } = readModelsList(file);
      const aioptEntry = models.find((m) => m.vendor === VENDOR);
      if (!aioptEntry) return null;

      const baseUrl = typeof aioptEntry.url === 'string' ? aioptEntry.url : '';
      const authTokenSet =
        typeof aioptEntry.apiKey === 'string' && aioptEntry.apiKey.trim() !== '';

      if (baseUrl === '' && !authTokenSet) return null;
      return {
        baseUrl,
        modelId: _applied.modelId,
        authTokenSet,
        compareModel: false,
      };
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
