// CodeArts adapter (exclusive).
//
// CodeArts (Huawei desktop agent) keeps custom models in Electron userData
// `app-settings.json` → `customModels[]`. Each entry is:
//   { uid, modelId, modelName, sourceType, apiFormat, modelUrl, apiKey, … }
// with `apiFormat` `openai` | `anthropic` and `modelUrl` without a trailing slash
// (the app appends `/chat/completions` or `/messages`).
//
// AiOpt owns entries whose `uid` starts with `aiopt-`, preserves the user's own
// customModels, and does not touch CodeArts' localStorage model selection
// (`codearts:selectedModelId`) — that stays a UI choice after the list updates.

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import {
  getAgentDef,
  wireModelName,
  type AgentDef,
  type ApiFormat,
} from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { readJsonObject, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import type { LiveBindingSnapshot } from './bindingLive';

const DEF: AgentDef = getAgentDef('codearts')!;
const UID_PREFIX = 'aiopt-';

const DEFAULT_INPUT_CONTEXT = 184_000;
const DEFAULT_OUTPUT_CONTEXT = 16_000;

function apiFormatFor(format: ApiFormat): 'openai' | 'anthropic' {
  return format === 'anthropic' ? 'anthropic' : 'openai';
}

function isAioptEntry(raw: unknown): raw is Record<string, unknown> {
  return (
    raw != null &&
    typeof raw === 'object' &&
    typeof (raw as Record<string, unknown>).uid === 'string' &&
    ((raw as Record<string, unknown>).uid as string).startsWith(UID_PREFIX)
  );
}

export function createCodeArtsAdapter(): AgentAdapter {
  return {
    def: DEF,

    configPaths() {
      return [resolveAgentFile(AGENT_FILES.codearts.settings)];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('codearts'));
    },

    writeLive({ provider, apiFormat, apiKey }: WriteLiveInput) {
      const file = resolveAgentFile(AGENT_FILES.codearts.settings);
      const config = readJsonObject(file);

      const existing: unknown[] = Array.isArray(config.customModels) ? config.customModels : [];
      const userModels = existing.filter((m) => !isAioptEntry(m));

      // CodeArts appends `/chat/completions` or `/messages` to modelUrl (no `/v1`).
      // AiOpt's loopback and most OpenAI/Anthropic-shaped hosts expect `/v1/...`, so
      // ensure the written base ends with `/v1` once.
      const stripped = provider.baseUrl.replace(/\/+$/, '');
      const modelUrl = /\/v1$/i.test(stripped) ? stripped : `${stripped}/v1`;
      const format = apiFormatFor(apiFormat);

      const aioptModels = provider.models.map((m) => {
        const wire = wireModelName(m);
        const entry: Record<string, unknown> = {
          uid: `${UID_PREFIX}${wire}`,
          modelId: wire,
          modelName: wire,
          sourceType: 'custom',
          apiFormat: format,
          modelUrl,
          modelType: 'textConversation',
          inputContextWindow: DEFAULT_INPUT_CONTEXT,
          outputContextWindow: DEFAULT_OUTPUT_CONTEXT,
          modelDesc: '',
          enabled: true,
        };
        if (apiKey) entry.apiKey = apiKey;
        else entry.apiKey = '';
        return entry;
      });

      const next = {
        ...config,
        customModels: [...userModels, ...aioptModels],
      };
      writeAgentConfigFile(file, `${JSON.stringify(next, null, 2)}\n`);
    },

    readLiveBinding(applied: AppliedBindingRecord): LiveBindingSnapshot | null {
      const config = readJsonObject(resolveAgentFile(AGENT_FILES.codearts.settings));
      const customModels = Array.isArray(config.customModels) ? config.customModels : [];
      const entry = customModels.find(
        (m) =>
          isAioptEntry(m) &&
          typeof (m as Record<string, unknown>).modelId === 'string' &&
          ((m as Record<string, unknown>).modelId as string) === applied.modelId,
      ) as Record<string, unknown> | undefined;
      // Fall back to any AiOpt-owned entry when the applied model id drifted.
      const fallback = entry ?? (customModels.find(isAioptEntry) as Record<string, unknown> | undefined);
      if (!fallback) return null;

      const baseUrl = typeof fallback.modelUrl === 'string' ? fallback.modelUrl : '';
      const modelId =
        typeof fallback.modelId === 'string' && fallback.modelId.trim() !== ''
          ? fallback.modelId
          : applied.modelId;
      const authTokenSet =
        typeof fallback.apiKey === 'string' && fallback.apiKey.trim() !== '';

      if (baseUrl === '' && modelId === '' && !authTokenSet) return null;
      return { baseUrl, modelId, authTokenSet };
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
