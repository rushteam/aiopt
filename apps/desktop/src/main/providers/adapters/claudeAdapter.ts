// Claude Code adapter.
//
// Claude Code reads its runtime config from `~/.claude/settings.json`; the pieces
// that steer the API endpoint live under the `env` block, which it exports into
// the CLI's environment. We MERGE into that block (preserving any other settings
// and env vars the user set) and rewrite only the three keys we own. Claude speaks
// the Anthropic wire format, so the manager only ever calls this with an
// anthropic-format provider (the compatibility gate enforces it upstream).

import type { AgentAdapter, WriteLiveInput } from './agentAdapter';
import { getAgentDef, type AgentDef } from '../../../shared/aiProviders';
import { agentConfigDir, claudeSettingsPath } from '../agentPaths';
import { readJsonObject, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import fs from 'node:fs';

const CLAUDE_DEF: AgentDef = getAgentDef('claude')!;

/** The env keys AiOpt manages in `~/.claude/settings.json`; others are left alone. */
const BASE_URL_KEY = 'ANTHROPIC_BASE_URL';
const AUTH_TOKEN_KEY = 'ANTHROPIC_AUTH_TOKEN';
const MODEL_KEY = 'ANTHROPIC_MODEL';

export function createClaudeAdapter(): AgentAdapter {
  return {
    def: CLAUDE_DEF,

    configPaths() {
      return [claudeSettingsPath()];
    },

    detectInstalled() {
      return fs.existsSync(agentConfigDir('claude'));
    },

    writeLive({ provider, modelId, apiKey }: WriteLiveInput) {
      const file = claudeSettingsPath();
      const existing = readJsonObject(file);
      const prevEnv =
        existing.env && typeof existing.env === 'object' && !Array.isArray(existing.env)
          ? (existing.env as Record<string, unknown>)
          : {};

      const env: Record<string, unknown> = {
        ...prevEnv,
        [BASE_URL_KEY]: provider.baseUrl,
        [MODEL_KEY]: modelId,
      };
      if (apiKey) {
        env[AUTH_TOKEN_KEY] = apiKey;
      } else {
        // No key on file → don't leave a stale token from a previous provider.
        delete env[AUTH_TOKEN_KEY];
      }

      const next = { ...existing, env };
      writeAgentConfigFile(file, `${JSON.stringify(next, null, 2)}\n`);
    },

    restoreDefault() {
      for (const file of this.configPaths()) restoreAgentConfigFile(file);
    },
  };
}
