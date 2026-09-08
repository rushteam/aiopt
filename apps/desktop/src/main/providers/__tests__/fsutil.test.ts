import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_BACKUP_SUFFIX, restoreAgentConfigFile, writeAgentConfigFile } from '../fsutil';
import { claudeSettingsPath } from '../agentPaths';
import { decodeIpcError, isIpcError } from '../../../shared/ipc-errors';

// fsutil writes/restores only allowlisted agent config paths. We point the agent
// home at a sandbox so the allowlist resolves under a temp dir — never the real ~.

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-fsutil-'));
  prevHome = process.env.AIOPT_AGENT_HOME;
  process.env.AIOPT_AGENT_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.AIOPT_AGENT_HOME;
  else process.env.AIOPT_AGENT_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (isIpcError(err)) return err.code;
    if (err instanceof Error) return decodeIpcError(err.message).code;
  }
  throw new Error('expected the call to throw a coded error');
}

describe('restoreAgentConfigFile', () => {
  it('writes the backup back over the file and deletes the backup', () => {
    const file = claudeSettingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A pre-AiOpt original, then a takeover write (which snapshots it to .bak).
    fs.writeFileSync(file, 'ORIGINAL', 'utf8');
    writeAgentConfigFile(file, 'AIOPT-WROTE-THIS');
    expect(fs.existsSync(`${file}${AGENT_BACKUP_SUFFIX}`)).toBe(true);

    restoreAgentConfigFile(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('ORIGINAL');
    expect(fs.existsSync(`${file}${AGENT_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('deletes an AiOpt-created file that never had a backup', () => {
    const file = claudeSettingsPath();
    // First-ever write with no original present → no backup is taken.
    writeAgentConfigFile(file, 'AIOPT-CREATED');
    expect(fs.existsSync(`${file}${AGENT_BACKUP_SUFFIX}`)).toBe(false);

    restoreAgentConfigFile(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('is a no-op when neither the file nor a backup exists', () => {
    const file = claudeSettingsPath();
    expect(() => restoreAgentConfigFile(file)).not.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses a path outside the allowlist with PERMISSION_DENIED', () => {
    const outside = path.join(home, 'not-an-agent-config.json');
    fs.writeFileSync(outside, 'keep me', 'utf8');
    expect(codeOf(() => restoreAgentConfigFile(outside))).toBe('PERMISSION_DENIED');
    // The refused path is left untouched.
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep me');
  });
});
