// OpenCode adapter (additive).
//
// OpenCode reads `~/.config/opencode/opencode.json`. It is a MERGE target, and the
// only additive agent AiOpt ships: providers coexist under the `provider` map, so we
// insert/overwrite just our own entry and preserve `$schema`, every other provider,
// `mcp`, `plugin`, and any unknown keys. We DO write the top-level `model` pointer
// (`"<slug>/<modelId>"`) to move the active model — cc-switch tracks "active" in its
// own DB and omits this key, but AiOpt's binding must land on disk.
//
// Our provider key is namespaced `aiopt-<providerId>` so it can never collide with a
// built-in OpenCode provider id (e.g. `openai`, `anthropic`). `npm` selects the
// AI-SDK adapter from the binding's resolved wire format (WriteLiveInput.apiFormat).

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, wireModelName, type AgentDef, type ApiFormat } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { readJsonObject, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import type { LiveBindingSnapshot } from './bindingLive';
import { aioptProviderSlug } from './bindingLive';

const OPENCODE_DEF: AgentDef = getAgentDef('opencode')!;

const OPENCODE_SCHEMA = 'https://opencode.ai/config.json';

/** apiFormat → the AI-SDK npm package that selects the wire adapter. */
const NPM_BY_FORMAT: Record<ApiFormat, string> = {
  openai: '@ai-sdk/openai-compatible',
  // opencode does not accept openai-responses providers (see AGENTS.acceptedFormats),
  // so this entry is never reached; kept for type-completeness, treated as OpenAI-shaped.
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

export function createOpenCodeAdapter(): AgentAdapter {
  return {
    def: OPENCODE_DEF,

    configPaths() {
      return [resolveAgentFile(AGENT_FILES.opencode.config)];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('opencode'));
    },

    writeLive({ provider, apiFormat, modelId, apiKey }: WriteLiveInput) {
      const file = resolveAgentFile(AGENT_FILES.opencode.config);
      const config = readJsonObject(file);
      const slug = `aiopt-${provider.id}`;

      const options: Record<string, unknown> = { baseURL: provider.baseUrl };
      if (apiKey) options.apiKey = apiKey;

      // Key each model by its outward wire name (alias when set, else id) so the
      // `model` pointer below — also the wire name — matches an entry here.
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

      const next = {
        $schema: typeof config.$schema === 'string' ? config.$schema : OPENCODE_SCHEMA,
        ...config,
        provider: providers,
        model: `${slug}/${modelId}`,
      };
      writeAgentConfigFile(file, `${JSON.stringify(next, null, 2)}\n`);
    },

    readLiveBinding(applied: AppliedBindingRecord): LiveBindingSnapshot | null {
      const config = readJsonObject(resolveAgentFile(AGENT_FILES.opencode.config));
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
