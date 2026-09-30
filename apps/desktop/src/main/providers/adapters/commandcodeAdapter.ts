// Command Code adapter (exclusive).
//
// Command Code keeps settings in ~/.commandcode/settings.json (model as
// "provider/model", modelProvider for which provider to use) and custom providers
// in ~/.commandcode/providers.json. AiOpt adds itself to providers.json and sets
// modelProvider + model in settings.json.

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, wireModelName, type AgentDef } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { readJsonObject, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import type { LiveBindingSnapshot } from './bindingLive';

const DEF: AgentDef = getAgentDef('commandcode')!;
const PROVIDER_SLUG = 'aiopt';

function objectAt(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createCommandCodeAdapter(): AgentAdapter {
  return {
    def: DEF,

    configPaths() {
      return [
        resolveAgentFile(AGENT_FILES.commandcode.settings),
        resolveAgentFile(AGENT_FILES.commandcode.providers),
      ];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('commandcode'));
    },

    writeLive({ provider, modelId, apiKey }: WriteLiveInput) {
      // providers.json: add our provider entry.
      const providersFile = resolveAgentFile(AGENT_FILES.commandcode.providers);
      const providersDoc = readJsonObject(providersFile);
      const providerMap = objectAt(providersDoc, 'provider');

      const models: Record<string, unknown> = {};
      for (const m of provider.models) {
        const wire = wireModelName(m);
        models[wire] = { name: wire };
      }

      const entry: Record<string, unknown> = {
        name: provider.name,
        api: 'openai-completions',
        baseURL: `${provider.baseUrl.replace(/\/+$/, '')}/v1`,
        models,
      };
      if (apiKey) entry.apiKey = apiKey;
      providerMap[PROVIDER_SLUG] = entry;
      writeAgentConfigFile(
        providersFile,
        `${JSON.stringify({ ...providersDoc, provider: providerMap }, null, 2)}\n`,
      );

      // settings.json: set modelProvider + model.
      const settingsFile = resolveAgentFile(AGENT_FILES.commandcode.settings);
      const settings = readJsonObject(settingsFile);
      const next = {
        ...settings,
        modelProvider: PROVIDER_SLUG,
        model: `${PROVIDER_SLUG}/${modelId}`,
      };
      writeAgentConfigFile(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
    },

    readLiveBinding(applied: AppliedBindingRecord): LiveBindingSnapshot | null {
      const settings = readJsonObject(resolveAgentFile(AGENT_FILES.commandcode.settings));
      if (settings.modelProvider !== PROVIDER_SLUG) return null;

      const modelValue = typeof settings.model === 'string' ? settings.model : '';
      const modelId = modelValue.startsWith(`${PROVIDER_SLUG}/`)
        ? modelValue.slice(PROVIDER_SLUG.length + 1)
        : applied.modelId;

      const providersDoc = readJsonObject(resolveAgentFile(AGENT_FILES.commandcode.providers));
      const providerMap = objectAt(providersDoc, 'provider');
      const entry = providerMap[PROVIDER_SLUG];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const entryObj = entry as Record<string, unknown>;
      const baseUrl = typeof entryObj.baseURL === 'string' ? entryObj.baseURL : '';
      const authTokenSet =
        typeof entryObj.apiKey === 'string' && entryObj.apiKey.trim() !== '';

      if (baseUrl === '' && modelId === '' && !authTokenSet) return null;
      return { baseUrl, modelId, authTokenSet };
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
