// Droid adapter (exclusive).
//
// Droid (Factory) keeps settings in ~/.factory/settings.json. Custom models are
// in the customModels[] array, each with {model, id, displayName, baseUrl, apiKey,
// provider}. The startup model is sessionDefaultSettings.model.
//
// AiOpt appends entries with id "custom:aiopt/<modelId>" and sets the startup model.
// The user's own customModels entries (those without the aiopt prefix) are preserved.

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

const DEF: AgentDef = getAgentDef('droid')!;
const ID_PREFIX = 'custom:aiopt/';

/** apiFormat → Droid's provider string. */
const PROVIDER_BY_FORMAT: Record<ApiFormat, string> = {
  openai: 'generic-chat-completion-api',
  'openai-responses': 'openai',
  anthropic: 'anthropic',
  gemini: 'generic-chat-completion-api',
};

function objectAt(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createDroidAdapter(): AgentAdapter {
  return {
    def: DEF,

    configPaths() {
      return [resolveAgentFile(AGENT_FILES.droid.settings)];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('droid'));
    },

    writeLive({ provider, apiFormat, modelId, apiKey }: WriteLiveInput) {
      const file = resolveAgentFile(AGENT_FILES.droid.settings);
      const config = readJsonObject(file);

      // Preserve the user's own customModels (those not from AiOpt).
      const existing: unknown[] = Array.isArray(config.customModels) ? config.customModels : [];
      const userModels = existing.filter(
        (m: unknown): m is Record<string, unknown> =>
          m != null &&
          typeof m === 'object' &&
          typeof (m as Record<string, unknown>).id === 'string' &&
          !((m as Record<string, unknown>).id as string).startsWith(ID_PREFIX),
      );

      // Add AiOpt's models.
      const aioptModels = provider.models.map((m) => {
        const wire = wireModelName(m);
        const entry: Record<string, unknown> = {
          model: wire,
          id: `${ID_PREFIX}${wire}`,
          displayName: wire,
          baseUrl: provider.baseUrl,
          provider: PROVIDER_BY_FORMAT[apiFormat],
          noImageSupport: false,
        };
        if (apiKey) entry.apiKey = apiKey;
        return entry;
      });

      const session = objectAt(config, 'sessionDefaultSettings');
      const next = {
        ...config,
        customModels: [...userModels, ...aioptModels],
        sessionDefaultSettings: {
          ...session,
          model: `${ID_PREFIX}${modelId}`,
        },
      };
      writeAgentConfigFile(file, `${JSON.stringify(next, null, 2)}\n`);
    },

    readLiveBinding(applied: AppliedBindingRecord): LiveBindingSnapshot | null {
      const config = readJsonObject(resolveAgentFile(AGENT_FILES.droid.settings));
      const session = objectAt(config, 'sessionDefaultSettings');
      const startupModel =
        typeof session.model === 'string' ? session.model : '';
      if (!startupModel.startsWith(ID_PREFIX)) return null;

      const modelId = startupModel.slice(ID_PREFIX.length);
      const customModels = Array.isArray(config.customModels) ? config.customModels : [];
      const entry = customModels.find(
        (m: unknown) =>
          m &&
          typeof m === 'object' &&
          (m as Record<string, unknown>).id === startupModel,
      ) as Record<string, unknown> | undefined;

      const baseUrl = typeof entry?.baseUrl === 'string' ? entry.baseUrl : '';
      const authTokenSet =
        typeof entry?.apiKey === 'string' && entry.apiKey.trim() !== '';

      if (baseUrl === '' && modelId === '' && !authTokenSet) return null;
      return { baseUrl, modelId, authTokenSet };
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
