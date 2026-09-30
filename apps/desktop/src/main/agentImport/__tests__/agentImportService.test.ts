import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process so the macOS Keychain is never queried (cursor session).
vi.mock('node:child_process', () => ({
  execSync: () => {
    throw new Error('no keychain in test');
  },
}));

import { AGENT_IMPORT_AGENT_IDS } from '../../../shared/agentImport';
import { scanAgentImportCandidates } from '../agentImportService';

describe('scanAgentImportCandidates', () => {
  let prevHome: string | undefined;
  let sandboxHome: string;

  beforeEach(() => {
    prevHome = process.env.AIOPT_AGENT_HOME;
    sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-agent-import-'));
    process.env.AIOPT_AGENT_HOME = sandboxHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.AIOPT_AGENT_HOME;
    else process.env.AIOPT_AGENT_HOME = prevHome;
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  });

  it('lists codex and claude with not_installed when agent dirs are absent', () => {
    const out = scanAgentImportCandidates();
    expect(out.map((c) => c.agentId)).toEqual([...AGENT_IMPORT_AGENT_IDS]);
    expect(out.every((c) => c.available === false)).toBe(true);
    expect(out.find((c) => c.agentId === 'codex')?.reason).toBe('not_installed');
  });

  it('serializes without undefined reason when available would omit reason', () => {
    const out = scanAgentImportCandidates();
    expect(() => structuredClone(out)).not.toThrow();
  });
});
