// Codex adapter.
//
// Codex splits its config across two files under `~/.codex`:
//   - auth.json  — JSON; we MERGE, setting only `OPENAI_API_KEY` and preserving
//     anything else (e.g. a ChatGPT OAuth `tokens` block) so a later switch back to
//     the built-in login still works.
//   - config.toml — we OVERWRITE the whole file with a single custom model provider.
//     TOML has no dependency-free merge here, so (matching cc-switch's on-disk switch
//     behavior) we rewrite it wholesale; the pristine original is kept once as
//     `config.toml.aiopt.bak` by fsutil's backup-before-write.
//
// Codex speaks the OpenAI wire format (Responses API), so the compatibility gate
// upstream only ever routes an openai-format provider here.

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, type AgentDef } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import type { AppliedBindingRecord } from '../bindingAppliedStore';
import { readJsonObject, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import type { LiveBindingSnapshot } from './bindingLive';
import { readTomlScalar } from './bindingLive';
import { tomlLine, tomlTableHeader } from '../tomlLite';

const CODEX_DEF: AgentDef = getAgentDef('codex')!;

const API_KEY_FIELD = 'OPENAI_API_KEY';

function renderConfigToml(input: WriteLiveInput): string {
  const { provider, modelId } = input;
  const lines = [
    tomlLine('model_provider', 'custom'),
    tomlLine('model', modelId),
    tomlLine('model_reasoning_effort', 'high'),
    tomlLine('disable_response_storage', true),
    '',
    tomlTableHeader('model_providers', 'custom'),
    tomlLine('name', provider.name),
    tomlLine('base_url', provider.baseUrl),
    tomlLine('wire_api', 'responses'),
    tomlLine('requires_openai_auth', true),
  ];
  return `${lines.join('\n')}\n`;
}

export function createCodexAdapter(): AgentAdapter {
  return {
    def: CODEX_DEF,

    configPaths() {
      return [resolveAgentFile(AGENT_FILES.codex.auth), resolveAgentFile(AGENT_FILES.codex.config)];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('codex'));
    },

    writeLive(input: WriteLiveInput) {
      const authFile = resolveAgentFile(AGENT_FILES.codex.auth);
      const auth = readJsonObject(authFile);
      if (input.apiKey) {
        auth[API_KEY_FIELD] = input.apiKey;
      } else {
        // No key on file → don't leave a stale token from a previous provider.
        delete auth[API_KEY_FIELD];
      }
      writeAgentConfigFile(authFile, `${JSON.stringify(auth, null, 2)}\n`);

      writeAgentConfigFile(resolveAgentFile(AGENT_FILES.codex.config), renderConfigToml(input));
    },

    readLiveBinding(_applied: AppliedBindingRecord): LiveBindingSnapshot | null {
      const configFile = resolveAgentFile(AGENT_FILES.codex.config);
      let text = '';
      try {
        text = fs.readFileSync(configFile, 'utf8');
      } catch {
        return null;
      }
      const modelId = readTomlScalar(text, 'model') ?? '';
      const baseUrl = readTomlScalar(text, 'base_url') ?? '';
      const auth = readJsonObject(resolveAgentFile(AGENT_FILES.codex.auth));
      const authTokenSet =
        typeof auth[API_KEY_FIELD] === 'string' && auth[API_KEY_FIELD].trim() !== '';
      if (baseUrl === '' && modelId === '' && !authTokenSet) return null;
      return { baseUrl, modelId, authTokenSet };
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
