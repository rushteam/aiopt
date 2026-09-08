// Where each agent keeps its native config on disk.
//
// This is DELIBERATELY separate from main/paths.ts: that module is the userData-only
// map for AiOpt's own data, whereas these paths live under the user's HOME
// (`~/.claude`, `~/.codex`, …) — writing there is a privileged capability outside
// userData (see docs/dev-rules/credentials-and-local-storage.md and the plan's
// security review). Two guardrails keep it safe:
//
//   1. `AIOPT_AGENT_HOME` overrides the home dir, so dev/test runs point at a
//      sandbox and never touch the developer's real `~/.claude`.
//   2. `isAllowedAgentConfigPath` is a strict allowlist — only the exact files
//      declared below may be written; fsutil refuses anything else.

import os from 'node:os';
import path from 'node:path';
import type { AgentId } from '../../shared/aiProviders';

/**
 * The home directory agent configs live under. `AIOPT_AGENT_HOME` (dev/test
 * sandbox) wins over the real OS home so we never clobber a developer's own config.
 */
export function agentHome(): string {
  const override = process.env.AIOPT_AGENT_HOME;
  return override && override.trim() !== '' ? override : os.homedir();
}

/**
 * The config files each agent reads, relative to the home dir, named per file so
 * adapters can reference them by role rather than by array index. This map doubles
 * as the write allowlist: only the exact paths declared here may be written, and
 * only for agents that appear. Agents land here as their adapters are implemented.
 *
 * Note the non-uniform layouts: pi keeps three files under `.pi/agent`, and
 * OpenCode lives under `.config/opencode` — so the install dir is tracked
 * separately (AGENT_INSTALL_DIRS) rather than assumed to be `.${id}`.
 */
export const AGENT_FILES = {
  claude: { settings: '.claude/settings.json' },
  codex: { auth: '.codex/auth.json', config: '.codex/config.toml' },
  gemini: { env: '.gemini/.env', settings: '.gemini/settings.json' },
  grok: { config: '.grok/config.toml' },
  opencode: { config: '.config/opencode/opencode.json' },
  pi: {
    auth: '.pi/agent/auth.json',
    models: '.pi/agent/models.json',
    settings: '.pi/agent/settings.json',
  },
} as const satisfies Partial<Record<AgentId, Readonly<Record<string, string>>>>;

/** The directory whose existence signals an agent is installed. */
const AGENT_INSTALL_DIRS: Partial<Record<AgentId, string>> = {
  claude: '.claude',
  codex: '.codex',
  gemini: '.gemini',
  grok: '.grok',
  opencode: '.config/opencode',
  pi: '.pi',
};

/** Resolve one relative config file (from AGENT_FILES) to an absolute path under home. */
export function resolveAgentFile(relativePath: string): string {
  return path.join(agentHome(), relativePath);
}

/** Absolute config paths for one agent under the current home (empty if none declared). */
export function agentConfigPaths(id: AgentId): string[] {
  const files = AGENT_FILES[id as keyof typeof AGENT_FILES] as
    | Readonly<Record<string, string>>
    | undefined;
  return Object.values(files ?? {}).map((rel) => resolveAgentFile(rel));
}

/** The directory an agent stores its config in (used for install detection). */
export function agentConfigDir(id: AgentId): string {
  return path.join(agentHome(), AGENT_INSTALL_DIRS[id] ?? `.${id}`);
}

/** Every allowlisted config path across all declared agents, for the current home. */
function allAllowedConfigPaths(): string[] {
  const home = agentHome();
  return Object.values(AGENT_FILES)
    .flatMap((files) => Object.values(files))
    .map((rel) => path.join(home, rel));
}

/**
 * Whether `target` is one of the exact allowlisted agent config files. Compared as
 * resolved absolute paths so `..` traversal can never smuggle a path past the list.
 */
export function isAllowedAgentConfigPath(target: string): boolean {
  const resolved = path.resolve(target);
  return allAllowedConfigPaths().some((allowed) => path.resolve(allowed) === resolved);
}

/** Convenience: Claude Code's settings file (`~/.claude/settings.json`). */
export function claudeSettingsPath(): string {
  return resolveAgentFile(AGENT_FILES.claude.settings);
}
