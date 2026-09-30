// fx adapter (exclusive).
//
// fx (Vercel Labs) keeps settings in ~/.fx/settings.json: providers of the user's own
// under "providers", the active provider as "provider", and each provider's model
// under "models". AiOpt adds itself as provider "aiopt" with protocol
// openai-chat-completions, sets "provider" to "aiopt", and "models.aiopt" to the model id.

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, wireModelName, type AgentDef } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { readJsonObject, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import type { LiveBindingSnapshot } from './bindingLive';

const DEF: AgentDef = getAgentDef('fx')!;
const PROVIDER_SLUG = 'aiopt';

function objectAt(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createFxAdapter(): AgentAdapter {
  return {
    def: DEF,

    configPaths() {
      return [resolveAgentFile(AGENT_FILES.fx.settings)];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('fx'));
    },

    writeLive({ provider, modelId, apiKey }: WriteLiveInput) {
      const file = resolveAgentFile(AGENT_FILES.fx.settings);
      const config = readJsonObject(file);

      const modelMetadata: Record<string, unknown> = {};
      for (const m of provider.models) {
        const wire = wireModelName(m);
        modelMetadata[wire] = { supports_tool_use: true, supports_vision: false };
      }

      const providers = objectAt(config, 'providers');
      const entry: Record<string, unknown> = {
        protocol: 'openai-chat-completions',
        base_url: `${provider.baseUrl.replace(/\/+$/, '')}/v1`,
        auth: apiKey ? { type: 'api_key', key: apiKey } : { type: 'none' },
        model_metadata: modelMetadata,
      };
      providers[PROVIDER_SLUG] = entry;

      const models = objectAt(config, 'models');
      models[PROVIDER_SLUG] = modelId;

      const next = {
        ...config,
        providers,
        provider: PROVIDER_SLUG,
        models,
      };
      writeAgentConfigFile(file, `${JSON.stringify(next, null, 2)}\n`);
    },

    readLiveBinding(_applied: AppliedBindingRecord): LiveBindingSnapshot | null {
      const config = readJsonObject(resolveAgentFile(AGENT_FILES.fx.settings));
      if (config.provider !== PROVIDER_SLUG) return null;

      const providers = objectAt(config, 'providers');
      const entry = providers[PROVIDER_SLUG];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const entryObj = entry as Record<string, unknown>;
      const baseUrl = typeof entryObj.base_url === 'string' ? entryObj.base_url : '';

      const auth = objectAt(entryObj, 'auth');
      const authTokenSet =
        auth.type === 'api_key' && typeof auth.key === 'string' && auth.key.trim() !== '';

      const models = objectAt(config, 'models');
      const modelId =
        typeof models[PROVIDER_SLUG] === 'string'
          ? (models[PROVIDER_SLUG] as string)
          : '';

      if (baseUrl === '' && modelId === '' && !authTokenSet) return null;
      return { baseUrl, modelId, authTokenSet };
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
