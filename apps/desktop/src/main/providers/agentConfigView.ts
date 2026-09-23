// The read-only view of one agent's config surface, for the renderer's config panel.
//
// Split out of providerManager for two reasons: it is the only place that STATS the
// agent config files (the manager otherwise delegates all disk work to adapters), and
// it owns the home-shortening used for display. Both resolve through `agentPaths`, so
// this module sees exactly the agent's slice of the write allowlist and nothing else —
// the panel can only ever describe files AiOpt is already willing to touch.
//
// It reports METADATA ONLY (role, display path, exists). It deliberately never reads a
// file: `codex/auth.json`, `gemini/.env` and `dsh/.credentials.yaml` hold plaintext
// secrets, and credentials-and-local-storage.md §1 forbids a secret transiting the
// preload or the renderer. Raw viewing is the OS's job — see `providersRevealConfig`.

import fs from 'node:fs';
import type { AgentId } from '../../shared/aiProviders';
import type { AgentConfigFile } from '../../shared/ipc-channels';
import { homeRelativeDisplayPath } from '../displayPath';
import { agentConfigDir, agentConfigFiles, agentHome } from './agentPaths';

/**
 * Shorten a home-rooted absolute path to `~/…` for display, mirroring the skills store's
 * `displayPath` — both now call the same {@link homeRelativeDisplayPath}. Shortened against
 * {@link agentHome} (not `os.homedir()`) so a sandboxed `AIOPT_AGENT_HOME` run displays the
 * same way a real one does.
 */
export function homeShortenedPath(abs: string): string {
  return homeRelativeDisplayPath(abs, agentHome());
}

/** One agent's config surface as the renderer sees it: where it lives, and which files exist. */
export interface AgentConfigView {
  installDirDisplay: string;
  configFiles: AgentConfigFile[];
}

/**
 * Describe one agent's managed config files. `exists` is sampled at call time (the snapshot
 * is rebuilt on every change, so the panel stays current); a stat failure is reported as
 * "missing" rather than thrown — this is a display read, and an unreadable file must not
 * take the whole snapshot down.
 */
export function describeAgentConfig(id: AgentId): AgentConfigView {
  return {
    installDirDisplay: homeShortenedPath(agentConfigDir(id)),
    configFiles: agentConfigFiles(id).map(({ role, path: abs }) => ({
      role,
      displayPath: homeShortenedPath(abs),
      exists: fileExists(abs),
    })),
  };
}

function fileExists(abs: string): boolean {
  try {
    return fs.existsSync(abs);
  } catch {
    return false;
  }
}
