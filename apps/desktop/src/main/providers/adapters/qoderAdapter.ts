// Qoder adapter (exclusive).
//
// Qoder CLI keeps providers in settings.json under "providers" (openai protocol with
// baseUrl + apiKey), and model.name as "provider/model":
//   {"providers":{"aiopt-<id>":{"displayName":…,"protocol":"openai",
//     "baseUrl":"…/v1","apiKey":…,"model":…,"models":[…]}},
//    "model":{"name":"aiopt-<id>/<model>"}}
//
// Qoder CN is the same binary for qoder.cn, differing only in config dir.
// Both are created by the shared factory below.

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, wireModelName, type AgentDef } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { readJsonObject, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import type { LiveBindingSnapshot } from './bindingLive';
import { aioptProviderSlug } from './bindingLive';

function objectAt(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function createQoderLikeAdapter(agentId: 'qoder' | 'qodercn'): AgentAdapter {
  const DEF: AgentDef = getAgentDef(agentId)!;
  const FILES = AGENT_FILES[agentId];

  return {
    def: DEF,

    configPaths() {
      return [resolveAgentFile(FILES.settings)];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir(agentId));
    },

    writeLive({ provider, modelId, apiKey }: WriteLiveInput) {
      const file = resolveAgentFile(FILES.settings);
      const config = readJsonObject(file);
      const slug = `aiopt-${provider.id}`;

      const models = provider.models.map((m) => {
        const wire = wireModelName(m);
        return { model: wire, displayName: wire };
      });

      const providers = objectAt(config, 'providers');
      const entry: Record<string, unknown> = {
        displayName: provider.name,
        protocol: 'openai',
        baseUrl: `${provider.baseUrl.replace(/\/+$/, '')}/v1`,
        model: modelId,
        models,
      };
      if (apiKey) entry.apiKey = apiKey;
      providers[slug] = entry;

      const model = objectAt(config, 'model');
      const next = {
        ...config,
        providers,
        model: { ...model, name: `${slug}/${modelId}` },
      };
      writeAgentConfigFile(file, `${JSON.stringify(next, null, 2)}\n`);
    },

    readLiveBinding(applied: AppliedBindingRecord): LiveBindingSnapshot | null {
      const config = readJsonObject(resolveAgentFile(FILES.settings));
      const model = objectAt(config, 'model');
      const modelName = typeof model.name === 'string' ? model.name : '';
      const slash = modelName.indexOf('/');
      const slugFromModel = slash > 0 ? modelName.slice(0, slash) : '';
      const modelFromName = slash > 0 ? modelName.slice(slash + 1) : '';
      const slug =
        aioptProviderSlug(applied) ??
        (slugFromModel.startsWith('aiopt-') ? slugFromModel : null);
      if (!slug) return null;

      const providers = objectAt(config, 'providers');
      const entry = providers[slug];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const entryObj = entry as Record<string, unknown>;
      const baseUrl = typeof entryObj.baseUrl === 'string' ? entryObj.baseUrl : '';
      const authTokenSet =
        typeof entryObj.apiKey === 'string' && entryObj.apiKey.trim() !== '';
      const modelId = modelFromName || applied.modelId;

      if (baseUrl === '' && modelId === '' && !authTokenSet) return null;
      return { baseUrl, modelId, authTokenSet };
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}

export function createQoderAdapter(): AgentAdapter {
  return createQoderLikeAdapter('qoder');
}

export function createQoderCnAdapter(): AgentAdapter {
  return createQoderLikeAdapter('qodercn');
}
