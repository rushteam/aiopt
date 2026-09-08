// pi adapter.
//
// pi keeps three files under `~/.pi/agent`, all MERGE targets keyed by a provider
// slug so pi's other providers are preserved:
//   - auth.json    — `{ "<slug>": { "type": "api_key", "key": "<key>" } }`
//   - models.json  — `{ "providers": { "<slug>": { baseUrl, api, models: [...] } } }`
//   - settings.json — startup binding: `defaultProvider` + `defaultModel`
//
// pi accepts all three wire formats; `api` maps the provider's apiFormat to pi's
// adapter id. Our slug is namespaced `aiopt-<providerId>` so it never collides with a
// built-in pi provider.

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, wireModelName, type AgentDef, type ApiFormat } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import { readJsonObject, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';

const PI_DEF: AgentDef = getAgentDef('pi')!;

/** apiFormat → pi's model-adapter id. */
const API_BY_FORMAT: Record<ApiFormat, string> = {
  openai: 'openai-completions',
  // pi does not accept openai-responses providers (see AGENTS.acceptedFormats), so this
  // entry is never reached; kept for type-completeness, treated as OpenAI-shaped.
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

export function createPiAdapter(): AgentAdapter {
  return {
    def: PI_DEF,

    configPaths() {
      return [
        resolveAgentFile(AGENT_FILES.pi.auth),
        resolveAgentFile(AGENT_FILES.pi.models),
        resolveAgentFile(AGENT_FILES.pi.settings),
      ];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('pi'));
    },

    writeLive({ provider, modelId, apiKey }: WriteLiveInput) {
      const slug = `aiopt-${provider.id}`;

      // auth.json — set our slug's key (or drop it if no key is stored).
      const authFile = resolveAgentFile(AGENT_FILES.pi.auth);
      const auth = readJsonObject(authFile);
      if (apiKey) auth[slug] = { type: 'api_key', key: apiKey };
      else delete auth[slug];
      writeJson(authFile, auth);

      // models.json — replace our slug's provider entry, preserve the rest.
      const modelsFile = resolveAgentFile(AGENT_FILES.pi.models);
      const modelsDoc = readJsonObject(modelsFile);
      const providers = objectAt(modelsDoc, 'providers');
      providers[slug] = {
        baseUrl: provider.baseUrl,
        api: API_BY_FORMAT[provider.apiFormat],
        // Each model is listed by its outward wire name (alias when set, else id) so
        // pi's defaultModel — also the wire name — always resolves to an entry.
        models: provider.models.map((m) => ({ id: wireModelName(m) })),
      };
      writeJson(modelsFile, { ...modelsDoc, providers });

      // settings.json — point pi's startup binding at this provider/model.
      const settingsFile = resolveAgentFile(AGENT_FILES.pi.settings);
      const settings = readJsonObject(settingsFile);
      writeJson(settingsFile, { ...settings, defaultProvider: slug, defaultModel: modelId });
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
