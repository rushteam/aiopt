// ZCode adapter (additive).
//
// ZCode (Zhipu) keeps providers in ~/.zcode/v2/config.json, OpenCode's shape with
// its own "kind" field. An anthropic provider is asked at baseURL + /v1/messages.
// AiOpt upserts its provider entry, using kind "anthropic".

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, wireModelName, type AgentDef } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { readJsonObject, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import type { LiveBindingSnapshot } from './bindingLive';
import { aioptProviderSlug } from './bindingLive';

const DEF: AgentDef = getAgentDef('zcode')!;

function objectAt(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createZCodeAdapter(): AgentAdapter {
  return {
    def: DEF,

    configPaths() {
      return [resolveAgentFile(AGENT_FILES.zcode.config)];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('zcode'));
    },

    writeLive({ provider, modelId, apiKey }: WriteLiveInput) {
      const file = resolveAgentFile(AGENT_FILES.zcode.config);
      const config = readJsonObject(file);
      const slug = `aiopt-${provider.id}`;

      const models: Record<string, unknown> = {};
      for (const m of provider.models) {
        const wire = wireModelName(m);
        models[wire] = { name: wire };
      }

      const providerEntry: Record<string, unknown> = {
        name: provider.name,
        kind: 'anthropic',
        options: apiKey
          ? { apiKey, baseURL: provider.baseUrl }
          : { baseURL: provider.baseUrl },
        enabled: true,
        source: 'custom',
        models,
      };

      const providers = objectAt(config, 'provider');
      providers[slug] = providerEntry;

      const next = { ...config, provider: providers };
      writeAgentConfigFile(file, `${JSON.stringify(next, null, 2)}\n`);
    },

    readLiveBinding(applied: AppliedBindingRecord): LiveBindingSnapshot | null {
      const config = readJsonObject(resolveAgentFile(AGENT_FILES.zcode.config));
      const slug = aioptProviderSlug(applied);
      if (!slug) return null;

      const providers = objectAt(config, 'provider');
      const entry = providers[slug];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const entryObj = entry as Record<string, unknown>;
      const options = objectAt(entryObj, 'options');
      const baseUrl = typeof options.baseURL === 'string' ? options.baseURL : '';
      const authTokenSet =
        typeof options.apiKey === 'string' && options.apiKey.trim() !== '';

      if (baseUrl === '' && !authTokenSet) return null;
      return { baseUrl, modelId: applied.modelId, authTokenSet, compareModel: false };
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
