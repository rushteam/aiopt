// Crush adapter (additive).
//
// Crush keeps a providers map in ~/.config/crush/crush.json, each with type, base_url,
// api_key, and a models array. Two model slots: models.large (provider + model) and
// models.small (provider + model). AiOpt upserts its provider and sets models.large.

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, wireModelName, type AgentDef } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { readJsonObject, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import type { LiveBindingSnapshot } from './bindingLive';
import { aioptProviderSlug } from './bindingLive';

const DEF: AgentDef = getAgentDef('crush')!;

function objectAt(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createCrushAdapter(): AgentAdapter {
  return {
    def: DEF,

    configPaths() {
      return [resolveAgentFile(AGENT_FILES.crush.config)];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('crush'));
    },

    writeLive({ provider, modelId, apiKey }: WriteLiveInput) {
      const file = resolveAgentFile(AGENT_FILES.crush.config);
      const config = readJsonObject(file);
      const slug = `aiopt-${provider.id}`;

      const models: Record<string, unknown>[] = [];
      for (const model of provider.models) {
        const wire = wireModelName(model);
        models.push({ id: wire, name: wire, context_window: 200000, default_max_tokens: 16384 });
      }

      const providers = objectAt(config, 'providers');
      const entry: Record<string, unknown> = {
        type: 'openai',
        name: provider.name,
        base_url: provider.baseUrl,
        models,
      };
      if (apiKey) entry.api_key = apiKey;
      providers[slug] = entry;

      const next = {
        ...config,
        providers,
        models: {
          ...objectAt(config, 'models'),
          large: { provider: slug, model: modelId },
        },
      };
      writeAgentConfigFile(file, `${JSON.stringify(next, null, 2)}\n`);
    },

    readLiveBinding(applied: AppliedBindingRecord): LiveBindingSnapshot | null {
      const config = readJsonObject(resolveAgentFile(AGENT_FILES.crush.config));
      const slug = aioptProviderSlug(applied);
      if (!slug) return null;

      const providers = objectAt(config, 'providers');
      const entry = providers[slug];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const entryObj = entry as Record<string, unknown>;
      const baseUrl = typeof entryObj.base_url === 'string' ? entryObj.base_url : '';
      const authTokenSet =
        typeof entryObj.api_key === 'string' && entryObj.api_key.trim() !== '';

      const large = objectAt(config, 'models').large;
      const largeObj =
        large && typeof large === 'object' && !Array.isArray(large)
          ? (large as Record<string, unknown>)
          : null;
      const modelId =
        largeObj && largeObj.provider === slug && typeof largeObj.model === 'string'
          ? largeObj.model
          : applied.modelId;

      if (baseUrl === '' && modelId === '' && !authTokenSet) return null;
      return { baseUrl, modelId, authTokenSet };
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
