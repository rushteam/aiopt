// Grok adapter.
//
// Grok reads a single `~/.grok/config.toml`. We OVERWRITE it with one model profile
// (named after the chosen model id) plus a `[models] default` pointer at it. As with
// Codex's config.toml there is no dependency-free TOML merge, so we rewrite the whole
// file (matching cc-switch); fsutil keeps the pristine original once as
// `config.toml.aiopt.bak`.
//
// Grok speaks the OpenAI wire format, so the compatibility gate only routes an
// openai-format provider here.

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, type AgentDef } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import { restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import { tomlLine, tomlString } from '../tomlLite';

const GROK_DEF: AgentDef = getAgentDef('grok')!;

const CONTEXT_WINDOW = 500000;

function renderConfigToml(input: WriteLiveInput): string {
  const { provider, modelId, apiKey } = input;
  const lines = [
    '[models]',
    tomlLine('default', modelId),
    '',
    // The profile segment is always quoted: model ids often contain dots/slashes,
    // which a bare TOML key would misread as nested tables.
    `[model.${tomlString(modelId)}]`,
    tomlLine('model', modelId),
    tomlLine('base_url', provider.baseUrl),
    tomlLine('name', provider.name),
  ];
  if (apiKey) lines.push(tomlLine('api_key', apiKey));
  lines.push(tomlLine('api_backend', 'responses'));
  lines.push(tomlLine('context_window', CONTEXT_WINDOW));
  return `${lines.join('\n')}\n`;
}

export function createGrokAdapter(): AgentAdapter {
  return {
    def: GROK_DEF,

    configPaths() {
      return [resolveAgentFile(AGENT_FILES.grok.config)];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('grok'));
    },

    writeLive(input: WriteLiveInput) {
      writeAgentConfigFile(resolveAgentFile(AGENT_FILES.grok.config), renderConfigToml(input));
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
