// Gemini CLI adapter.
//
// Gemini CLI reads two files under `~/.gemini`:
//   - .env         — we OVERWRITE it with the three env vars that steer the endpoint
//     (`GEMINI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_GEMINI_BASE_URL`), emitted in
//     alphabetical order as bare `KEY=VALUE` lines (matching cc-switch). The chosen
//     model lives here, not in settings.json.
//   - settings.json — we MERGE, setting only `security.auth.selectedType` to
//     `gemini-api-key` so the CLI picks the API-key auth path; every other setting
//     is preserved.
//
// Gemini speaks its own wire format, so the compatibility gate only routes a
// gemini-format provider here.

import fs from 'node:fs';
import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, type AgentDef } from '../../../shared/aiProviders';
import { AGENT_FILES, agentConfigDir, resolveAgentFile } from '../agentPaths';
import { readJsonObject, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';

const GEMINI_DEF: AgentDef = getAgentDef('gemini')!;

function renderEnv(input: WriteLiveInput): string {
  // Alphabetical by key; GEMINI_API_KEY only when a key is stored.
  const entries: Array<[string, string]> = [];
  if (input.apiKey) entries.push(['GEMINI_API_KEY', input.apiKey]);
  entries.push(['GEMINI_MODEL', input.modelId]);
  entries.push(['GOOGLE_GEMINI_BASE_URL', input.provider.baseUrl]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${entries.map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

/** Return `obj[key]` as a plain object, or `{}` if absent/not an object. */
function objectAt(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createGeminiAdapter(): AgentAdapter {
  return {
    def: GEMINI_DEF,

    configPaths() {
      return [resolveAgentFile(AGENT_FILES.gemini.env), resolveAgentFile(AGENT_FILES.gemini.settings)];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('gemini'));
    },

    writeLive(input: WriteLiveInput) {
      writeAgentConfigFile(resolveAgentFile(AGENT_FILES.gemini.env), renderEnv(input));

      const settingsFile = resolveAgentFile(AGENT_FILES.gemini.settings);
      const settings = readJsonObject(settingsFile);
      const security = objectAt(settings, 'security');
      const auth = objectAt(security, 'auth');
      const next = {
        ...settings,
        security: { ...security, auth: { ...auth, selectedType: 'gemini-api-key' } },
      };
      writeAgentConfigFile(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
