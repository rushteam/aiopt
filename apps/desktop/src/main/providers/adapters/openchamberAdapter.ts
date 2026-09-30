// OpenChamber adapter (additive).
//
// OpenChamber is a desktop front-end for OpenCode. It runs on OpenCode's config
// (~/.config/opencode/opencode.json), so the binding goes into that same file.
// The adapter is structurally identical to OpenCode's — only the install dir
// and detection differ (OpenChamber lives under ~/.config/openchamber).

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, wireModelName, type AgentDef, type ApiFormat } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { readJsonObject, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import type { LiveBindingSnapshot } from './bindingLive';
import { aioptProviderSlug } from './bindingLive';

const DEF: AgentDef = getAgentDef('openchamber')!;

const NPM_BY_FORMAT: Record<ApiFormat, string> = {
  openai: '@ai-sdk/openai-compatible',
  'openai-responses': '@ai-sdk/openai-compatible',
  anthropic: '@ai-sdk/anthropic',
  gemini: '@ai-sdk/google',
};

function objectAt(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createOpenChamberAdapter(): AgentAdapter {
  return {
    def: DEF,

    configPaths() {
      return [resolveAgentFile(AGENT_FILES.openchamber.config)];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('openchamber'));
    },

    writeLive({ provider, apiFormat, modelId, apiKey }: WriteLiveInput) {
      const file = resolveAgentFile(AGENT_FILES.openchamber.config);
      const config = readJsonObject(file);
      const slug = `aiopt-${provider.id}`;

      const options: Record<string, unknown> = { baseURL: provider.baseUrl };
      if (apiKey) options.apiKey = apiKey;

      const models: Record<string, unknown> = {};
      for (const model of provider.models) {
        const wire = wireModelName(model);
        models[wire] = { name: wire };
      }

      const providers = objectAt(config, 'provider');
      providers[slug] = {
        npm: NPM_BY_FORMAT[apiFormat],
        name: provider.name,
        options,
        models,
      };

      const next = { ...config, provider: providers, model: `${slug}/${modelId}` };
      writeAgentConfigFile(file, `${JSON.stringify(next, null, 2)}\n`);
    },

    readLiveBinding(applied: AppliedBindingRecord): LiveBindingSnapshot | null {
      const config = readJsonObject(resolveAgentFile(AGENT_FILES.openchamber.config));
      const modelPtr = typeof config.model === 'string' ? config.model : '';
      const slash = modelPtr.indexOf('/');
      const slugFromPtr = slash > 0 ? modelPtr.slice(0, slash) : '';
      const modelFromPtr = slash > 0 ? modelPtr.slice(slash + 1) : '';
      const slug =
        aioptProviderSlug(applied) ?? (slugFromPtr.startsWith('aiopt-') ? slugFromPtr : null);
      if (!slug) return null;

      const providers = objectAt(config, 'provider');
      const entry = providers[slug];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const options = objectAt(entry as Record<string, unknown>, 'options');
      const baseUrl = typeof options.baseURL === 'string' ? options.baseURL : '';
      const authTokenSet = typeof options.apiKey === 'string' && options.apiKey.trim() !== '';
      const modelId = modelFromPtr || applied.modelId;
      if (baseUrl === '' && modelId === '' && !authTokenSet) return null;
      return { baseUrl, modelId, authTokenSet };
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
