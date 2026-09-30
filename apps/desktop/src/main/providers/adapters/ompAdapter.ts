// omp adapter (exclusive).
//
// omp (oh-my-pi) keeps config.yml + models.yml under ~/.omp/agent, YAML format.
// It is Pi-derived with the same provider/model/auth structure:
//   config.yml:  defaultProvider + defaultModel
//   models.yml:  providers.<slug> = { baseUrl, api, models: [{id}] }
//
// AiOpt upserts its provider under "providers" in models.yml and sets defaultProvider
// + defaultModel in config.yml.

import fs from 'node:fs';
import { parseDocument, isMap, type YAMLMap } from 'yaml';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, wireModelName, type AgentDef, type ApiFormat } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import type { LiveBindingSnapshot } from './bindingLive';
import { aioptProviderSlug, readYamlConfigDocument } from './bindingLive';

const DEF: AgentDef = getAgentDef('omp')!;

const API_BY_FORMAT: Record<ApiFormat, string> = {
  openai: 'openai-completions',
  'openai-responses': 'openai-completions',
  anthropic: 'anthropic-messages',
  gemini: 'openai-completions',
};

function readConfigDocument(file: string): ReturnType<typeof parseDocument> {
  try {
    return parseDocument(fs.readFileSync(file, 'utf-8'));
  } catch {
    return parseDocument('');
  }
}

function mapAt(doc: ReturnType<typeof parseDocument>, path: (string | number)[]): YAMLMap {
  const existing = doc.getIn(path);
  if (isMap(existing)) return existing;
  const created = doc.createNode({}) as YAMLMap;
  doc.setIn(path, created);
  return created;
}

export function createOmpAdapter(): AgentAdapter {
  return {
    def: DEF,

    configPaths() {
      return [
        resolveAgentFile(AGENT_FILES.omp.config),
        resolveAgentFile(AGENT_FILES.omp.models),
      ];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('omp'));
    },

    writeLive({ provider, apiFormat, modelId, apiKey }: WriteLiveInput) {
      const slug = `aiopt-${provider.id}`;

      // models.yml: upsert provider.
      const modelsFile = resolveAgentFile(AGENT_FILES.omp.models);
      const modelsDoc = readConfigDocument(modelsFile);
      const entry = mapAt(modelsDoc, ['providers', slug]);
      entry.set('baseUrl', provider.baseUrl);
      entry.set('api', API_BY_FORMAT[apiFormat]);
      const modelsList = provider.models.map((m) => ({ id: wireModelName(m) }));
      entry.set('models', modelsList);
      if (apiKey) entry.set('apiKey', apiKey);
      else entry.delete('apiKey');
      writeAgentConfigFile(modelsFile, modelsDoc.toString());

      // config.yml: set startup binding.
      const configFile = resolveAgentFile(AGENT_FILES.omp.config);
      const configDoc = readConfigDocument(configFile);
      configDoc.set('defaultProvider', slug);
      configDoc.set('defaultModel', modelId);
      writeAgentConfigFile(configFile, configDoc.toString());
    },

    readLiveBinding(applied: AppliedBindingRecord): LiveBindingSnapshot | null {
      const configFile = resolveAgentFile(AGENT_FILES.omp.config);
      const configDoc = readYamlConfigDocument(configFile);
      const defaultProvider =
        typeof configDoc.get('defaultProvider') === 'string'
          ? (configDoc.get('defaultProvider') as string)
          : '';
      const modelId =
        typeof configDoc.get('defaultModel') === 'string'
          ? (configDoc.get('defaultModel') as string)
          : '';
      const slug =
        aioptProviderSlug(applied) ??
        (defaultProvider.startsWith('aiopt-') ? defaultProvider : null);
      if (!slug) return null;

      const modelsDoc = readYamlConfigDocument(resolveAgentFile(AGENT_FILES.omp.models));
      const entry = modelsDoc.getIn(['providers', slug]);
      const baseUrl =
        isMap(entry) && typeof entry.get('baseUrl') === 'string'
          ? (entry.get('baseUrl') as string)
          : '';
      const authTokenSet =
        isMap(entry) &&
        typeof entry.get('apiKey') === 'string' &&
        (entry.get('apiKey') as string).trim() !== '';

      if (baseUrl === '' && modelId === '' && !authTokenSet) return null;
      return { baseUrl, modelId, authTokenSet };
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
