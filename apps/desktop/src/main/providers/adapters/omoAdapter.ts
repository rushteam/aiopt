// OmO adapter.
//
// OmO (omo-ai) is a Pi fork that keeps the identical three-file layout under
// ~/.omo/agent: auth.json, models.json, settings.json. The adapter is identical
// to Pi's, only the paths differ.

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, wireModelName, type AgentDef, type ApiFormat } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { readJsonObject, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import type { LiveBindingSnapshot } from './bindingLive';
import { aioptProviderSlug } from './bindingLive';

const DEF: AgentDef = getAgentDef('omo')!;

const API_BY_FORMAT: Record<ApiFormat, string> = {
  openai: 'openai-completions',
  'openai-responses': 'openai-completions',
  anthropic: 'anthropic-messages',
  gemini: 'google-generative-ai',
};

function objectAt(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function writeJson(file: string, doc: unknown): void {
  writeAgentConfigFile(file, `${JSON.stringify(doc, null, 2)}\n`);
}

export function createOmoAdapter(): AgentAdapter {
  return {
    def: DEF,

    configPaths() {
      return [
        resolveAgentFile(AGENT_FILES.omo.auth),
        resolveAgentFile(AGENT_FILES.omo.models),
        resolveAgentFile(AGENT_FILES.omo.settings),
      ];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('omo'));
    },

    writeLive({ provider, apiFormat, modelId, apiKey }: WriteLiveInput) {
      const slug = `aiopt-${provider.id}`;

      const authFile = resolveAgentFile(AGENT_FILES.omo.auth);
      const auth = readJsonObject(authFile);
      if (apiKey) auth[slug] = { type: 'api_key', key: apiKey };
      else delete auth[slug];
      writeJson(authFile, auth);

      const modelsFile = resolveAgentFile(AGENT_FILES.omo.models);
      const modelsDoc = readJsonObject(modelsFile);
      const providers = objectAt(modelsDoc, 'providers');
      providers[slug] = {
        baseUrl: provider.baseUrl,
        api: API_BY_FORMAT[apiFormat],
        models: provider.models.map((m) => ({ id: wireModelName(m) })),
      };
      writeJson(modelsFile, { ...modelsDoc, providers });

      const settingsFile = resolveAgentFile(AGENT_FILES.omo.settings);
      const settings = readJsonObject(settingsFile);
      writeJson(settingsFile, { ...settings, defaultProvider: slug, defaultModel: modelId });
    },

    readLiveBinding(applied: AppliedBindingRecord): LiveBindingSnapshot | null {
      const settings = readJsonObject(resolveAgentFile(AGENT_FILES.omo.settings));
      const defaultProvider =
        typeof settings.defaultProvider === 'string' ? settings.defaultProvider : '';
      const modelId = typeof settings.defaultModel === 'string' ? settings.defaultModel : '';
      const slug =
        aioptProviderSlug(applied) ??
        (defaultProvider.startsWith('aiopt-') ? defaultProvider : null);
      if (!slug) return null;

      const modelsDoc = readJsonObject(resolveAgentFile(AGENT_FILES.omo.models));
      const providers = objectAt(modelsDoc, 'providers');
      const entry = providers[slug];
      const entryObj =
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : null;
      const baseUrl = typeof entryObj?.baseUrl === 'string' ? entryObj.baseUrl : '';

      const auth = readJsonObject(resolveAgentFile(AGENT_FILES.omo.auth));
      const authEntry = auth[slug];
      const authEntryObj =
        authEntry && typeof authEntry === 'object' && !Array.isArray(authEntry)
          ? (authEntry as Record<string, unknown>)
          : null;
      const authTokenSet = Boolean(
        typeof authEntryObj?.key === 'string' && authEntryObj.key.trim() !== '',
      );

      if (baseUrl === '' && modelId === '' && !authTokenSet) return null;
      return { baseUrl, modelId, authTokenSet };
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
