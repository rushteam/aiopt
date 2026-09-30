// Cline adapter (exclusive).
//
// Cline's CLI keeps providers in ~/.cline/data/settings/providers.json:
//   {"version":1,"lastUsedProvider":"<id>","providers":{"<id>":{
//     "settings":{"provider":"<id>","apiKey":…,"model":…,"baseUrl":…},
//     "updatedAt":…,"tokenSource":"manual"}}}
//
// AiOpt takes the built-in "openai-compatible" slot, sets the base URL and key,
// and writes the model list into models.json beside it so models appear in Cline's
// picker. lastUsedProvider is set to "openai-compatible" so sessions start on it.

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, wireModelName, type AgentDef } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { readJsonObject, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import type { LiveBindingSnapshot } from './bindingLive';

const DEF: AgentDef = getAgentDef('cline')!;

const SLOT = 'openai-compatible';

function objectAt(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createClineAdapter(): AgentAdapter {
  return {
    def: DEF,

    configPaths() {
      return [
        resolveAgentFile(AGENT_FILES.cline.providers),
        resolveAgentFile(AGENT_FILES.cline.models),
      ];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('cline'));
    },

    writeLive({ provider, modelId, apiKey }: WriteLiveInput) {
      const providersFile = resolveAgentFile(AGENT_FILES.cline.providers);
      const config = readJsonObject(providersFile);

      const providers = objectAt(config, 'providers');
      providers[SLOT] = {
        settings: {
          provider: SLOT,
          apiKey: apiKey ?? '',
          model: modelId,
          baseUrl: `${provider.baseUrl.replace(/\/+$/, '')}/v1`,
        },
        updatedAt: new Date().toISOString(),
        tokenSource: 'manual',
      };

      const next = {
        version: 1,
        ...config,
        providers,
        lastUsedProvider: SLOT,
      };
      writeAgentConfigFile(providersFile, `${JSON.stringify(next, null, 2)}\n`);

      // models.json: write the model list so models appear in Cline's picker.
      const modelsFile = resolveAgentFile(AGENT_FILES.cline.models);
      const modelsDoc = readJsonObject(modelsFile);
      const modelProviders = objectAt(modelsDoc, 'providers');
      const modelEntries: Record<string, unknown> = {};
      for (const m of provider.models) {
        const wire = wireModelName(m);
        modelEntries[wire] = { id: wire, name: wire };
      }
      modelProviders[SLOT] = {
        provider: { name: provider.name, baseUrl: `${provider.baseUrl.replace(/\/+$/, '')}/v1`, defaultModelId: modelId },
        models: modelEntries,
      };
      writeAgentConfigFile(modelsFile, `${JSON.stringify({ version: 1, ...modelsDoc, providers: modelProviders }, null, 2)}\n`);
    },

    readLiveBinding(_applied: AppliedBindingRecord): LiveBindingSnapshot | null {
      const config = readJsonObject(resolveAgentFile(AGENT_FILES.cline.providers));
      const lastUsed = typeof config.lastUsedProvider === 'string' ? config.lastUsedProvider : '';
      if (lastUsed !== SLOT) return null;

      const providers = objectAt(config, 'providers');
      const entry = providers[SLOT];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const settings = objectAt(entry as Record<string, unknown>, 'settings');
      const baseUrl = typeof settings.baseUrl === 'string' ? settings.baseUrl : '';
      const modelId = typeof settings.model === 'string' ? settings.model : '';
      const authTokenSet =
        typeof settings.apiKey === 'string' && settings.apiKey.trim() !== '';

      if (baseUrl === '' && modelId === '' && !authTokenSet) return null;
      return { baseUrl, modelId, authTokenSet };
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
