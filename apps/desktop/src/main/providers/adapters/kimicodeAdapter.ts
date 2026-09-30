// Kimi Code adapter (exclusive).
//
// Kimi Code (Moonshot) keeps config.toml under ~/.kimi-code with:
//   [providers.<name>]   — base_url, api_key, api ("chat_completions")
//   [models."<key>"]     — provider, model
//   default_model = "<key>"
//
// AiOpt adds a [providers.aiopt] section and one [models."aiopt/<modelId>"] table,
// then sets default_model. The whole file is rewritten (no TOML merge dependency).

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, type AgentDef } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import type { LiveBindingSnapshot } from './bindingLive';
import { readTomlTable, readTomlScalar, escapeRegExp } from './bindingLive';
import { tomlLine, tomlString } from '../tomlLite';

const DEF: AgentDef = getAgentDef('kimicode')!;
const PROVIDER_SLUG = 'aiopt';

function renderConfigToml(input: WriteLiveInput): string {
  const { provider, modelId, apiKey } = input;
  const modelKey = `${PROVIDER_SLUG}/${modelId}`;
  const lines = [
    tomlLine('default_model', modelKey),
    '',
    `[providers.${PROVIDER_SLUG}]`,
    tomlLine('base_url', `${provider.baseUrl.replace(/\/+$/, '')}/v1`),
    tomlLine('api', 'chat_completions'),
  ];
  if (apiKey) lines.push(tomlLine('api_key', apiKey));
  lines.push('');
  lines.push(`[models.${tomlString(modelKey)}]`);
  lines.push(tomlLine('provider', PROVIDER_SLUG));
  lines.push(tomlLine('model', modelId));
  return `${lines.join('\n')}\n`;
}

export function createKimiCodeAdapter(): AgentAdapter {
  return {
    def: DEF,

    configPaths() {
      return [resolveAgentFile(AGENT_FILES.kimicode.config)];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('kimicode'));
    },

    writeLive(input: WriteLiveInput) {
      writeAgentConfigFile(
        resolveAgentFile(AGENT_FILES.kimicode.config),
        renderConfigToml(input),
      );
    },

    readLiveBinding(_applied: AppliedBindingRecord): LiveBindingSnapshot | null {
      const configFile = resolveAgentFile(AGENT_FILES.kimicode.config);
      let text = '';
      try {
        text = fs.readFileSync(configFile, 'utf8');
      } catch {
        return null;
      }

      const defaultModel = readTomlScalar(text, 'default_model');
      if (!defaultModel || !defaultModel.startsWith(`${PROVIDER_SLUG}/`)) return null;

      const modelId = defaultModel.slice(PROVIDER_SLUG.length + 1);
      const providerTable = readTomlTable(
        text,
        new RegExp(`^\\s*\\[providers\\.${escapeRegExp(PROVIDER_SLUG)}\\]\\s*$`, 'm'),
      );
      const baseUrl = providerTable.base_url ?? '';
      const authTokenSet =
        typeof providerTable.api_key === 'string' && providerTable.api_key.trim() !== '';

      if (baseUrl === '' && modelId === '' && !authTokenSet) return null;
      return { baseUrl, modelId, authTokenSet };
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
