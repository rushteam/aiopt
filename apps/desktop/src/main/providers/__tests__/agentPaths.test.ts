import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_FILES,
  agentConfigDir,
  agentConfigFiles,
  agentConfigPaths,
  isAllowedAgentConfigPath,
  resolveAgentConfigRole,
  resolveAgentFile,
} from '../agentPaths';

// The write allowlist is DERIVED from AGENT_SPECS (shared/aiProviders.ts). This suite is the
// security guard on that derivation: it pins the exact set of writable paths so any future
// edit to AGENT_SPECS that adds, drops, or moves a config file fails loudly here — never
// silently widening what fsutil.writeAgentConfigFile is willing to touch.

/**
 * The known-good allowlist, written out by hand (NOT derived) so it is an independent
 * check on the derivation. Keep in sync deliberately when an agent's config files change.
 */
const EXPECTED_AGENT_FILES: Record<string, Record<string, string>> = {
  claude: { settings: '.claude/settings.json' },
  codex: { auth: '.codex/auth.json', config: '.codex/config.toml' },
  dsh: { settings: '.dsh/settings.yaml', credentials: '.dsh/.credentials.yaml' },
  gemini: { env: '.gemini/.env', settings: '.gemini/settings.json' },
  grok: { config: '.grok/config.toml' },
  hermes: { config: '.hermes/config.yaml' },
  opencode: { config: '.config/opencode/opencode.json' },
  pi: {
    auth: '.pi/agent/auth.json',
    models: '.pi/agent/models.json',
    settings: '.pi/agent/settings.json',
  },
};

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-agent-home-'));
  prevHome = process.env.AIOPT_AGENT_HOME;
  process.env.AIOPT_AGENT_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.AIOPT_AGENT_HOME;
  else process.env.AIOPT_AGENT_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('AGENT_FILES write allowlist (derived from AGENT_SPECS)', () => {
  it('matches the known-good set of writable config files exactly', () => {
    expect(AGENT_FILES).toEqual(EXPECTED_AGENT_FILES);
  });

  it('allows exactly the declared paths and refuses everything else', () => {
    // Every declared path (resolved under the sandbox home) is allowlisted...
    for (const files of Object.values(EXPECTED_AGENT_FILES)) {
      for (const rel of Object.values(files)) {
        expect(isAllowedAgentConfigPath(resolveAgentFile(rel))).toBe(true);
      }
    }
    // ...and nothing outside it is, including traversal and lookalike paths.
    expect(isAllowedAgentConfigPath(resolveAgentFile('.claude/other.json'))).toBe(false);
    expect(isAllowedAgentConfigPath(resolveAgentFile('.cursor/config.json'))).toBe(false); // skills-only agent
    expect(isAllowedAgentConfigPath(path.join(home, '../evil.json'))).toBe(false);
    expect(isAllowedAgentConfigPath('/etc/passwd')).toBe(false);
  });

  it('exposes literal per-role paths for adapters (AGENT_FILES.dsh.settings etc.)', () => {
    // A representative sample of the by-key access adapters rely on.
    expect(AGENT_FILES.dsh.settings).toBe('.dsh/settings.yaml');
    expect(AGENT_FILES.dsh.credentials).toBe('.dsh/.credentials.yaml');
    expect(AGENT_FILES.pi.models).toBe('.pi/agent/models.json');
    expect(AGENT_FILES.claude.settings).toBe('.claude/settings.json');
  });
});

describe('agentConfigDir (install detection, derived from AGENT_SPECS)', () => {
  it('resolves each bindable agent install dir under home', () => {
    expect(agentConfigDir('opencode')).toBe(path.join(home, '.config/opencode'));
    expect(agentConfigDir('pi')).toBe(path.join(home, '.pi'));
    expect(agentConfigDir('dsh')).toBe(path.join(home, '.dsh'));
  });
});

describe('agentConfigFiles / agentConfigPaths (role-keyed view of the allowlist)', () => {
  it('lists every declared file with its role, in spec order', () => {
    expect(agentConfigFiles('codex')).toEqual([
      { role: 'auth', path: path.join(home, '.codex/auth.json') },
      { role: 'config', path: path.join(home, '.codex/config.toml') },
    ]);
  });

  it('stays in step with agentConfigPaths (one derives from the other)', () => {
    for (const id of Object.keys(EXPECTED_AGENT_FILES)) {
      expect(agentConfigFiles(id as never).map((f) => f.path)).toEqual(agentConfigPaths(id as never));
    }
  });

  it('is empty for a skills-only agent that declares no config files', () => {
    expect(agentConfigFiles('cursor')).toEqual([]);
    expect(agentConfigPaths('cursor')).toEqual([]);
  });
});

describe('resolveAgentConfigRole (renderer-facing symbolic lookup)', () => {
  it('resolves a declared role to its allowlisted absolute path', () => {
    const target = resolveAgentConfigRole('dsh', 'credentials');
    expect(target).toBe(path.join(home, '.dsh/.credentials.yaml'));
    expect(isAllowedAgentConfigPath(target!)).toBe(true);
  });

  it('returns null for a role the agent does not declare', () => {
    expect(resolveAgentConfigRole('claude', 'auth')).toBeNull();
    expect(resolveAgentConfigRole('cursor', 'settings')).toBeNull();
  });

  it('returns null for an inherited Object.prototype key', () => {
    // `role` is renderer input: a plain `files[role]` would return a function here, and
    // whatever came out would be carried downstream as if it were a path.
    for (const role of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(resolveAgentConfigRole('claude', role)).toBeNull();
    }
  });
});
