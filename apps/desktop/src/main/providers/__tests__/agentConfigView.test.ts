import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeAgentConfig, homeShortenedPath } from '../agentConfigView';

// The config view is what the renderer's read-only config panel is built from. Two
// properties matter here and are asserted below: it reports METADATA ONLY (no file content
// ever, not even redacted — several of these files hold a plaintext key), and it describes
// exactly the agent's slice of the write allowlist, so the panel cannot name a file AiOpt
// is not willing to touch.

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-config-view-'));
  prevHome = process.env.AIOPT_AGENT_HOME;
  process.env.AIOPT_AGENT_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.AIOPT_AGENT_HOME;
  else process.env.AIOPT_AGENT_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

describe('homeShortenedPath', () => {
  it('shortens a home-rooted path and leaves anything else alone', () => {
    expect(homeShortenedPath(path.join(home, '.codex/auth.json'))).toBe('~/.codex/auth.json');
    expect(homeShortenedPath(home)).toBe('~');
    expect(homeShortenedPath('/etc/passwd')).toBe('/etc/passwd');
  });

  it('does not shorten a sibling directory that merely shares the home prefix', () => {
    expect(homeShortenedPath(`${home}-other/x.json`)).toBe(`${home}-other/x.json`);
  });
});

describe('describeAgentConfig', () => {
  it('reports each managed file with its role, display path and existence', () => {
    write('.codex/auth.json', '{"OPENAI_API_KEY":"sk-super-secret"}');
    const view = describeAgentConfig('codex');
    expect(view.installDirDisplay).toBe('~/.codex');
    expect(view.configFiles).toEqual([
      { role: 'auth', displayPath: '~/.codex/auth.json', exists: true },
      { role: 'config', displayPath: '~/.codex/config.toml', exists: false },
    ]);
  });

  it('never carries file content — not even for a file holding a plaintext key', () => {
    write('.codex/auth.json', '{"OPENAI_API_KEY":"sk-super-secret"}');
    write('.gemini/.env', 'GEMINI_API_KEY=sk-also-secret');
    for (const id of ['codex', 'gemini'] as const) {
      const serialized = JSON.stringify(describeAgentConfig(id));
      expect(serialized).not.toContain('sk-super-secret');
      expect(serialized).not.toContain('sk-also-secret');
      expect(serialized).not.toContain('API_KEY');
    }
  });

  it('describes a non-standard layout from the spec, not a guessed one', () => {
    const view = describeAgentConfig('opencode');
    expect(view.installDirDisplay).toBe('~/.config/opencode');
    expect(view.configFiles.map((f) => f.displayPath)).toEqual([
      '~/.config/opencode/opencode.json',
    ]);
  });

  it('reports no files for a skills-only agent (nothing is managed)', () => {
    expect(describeAgentConfig('cursor').configFiles).toEqual([]);
  });
});
