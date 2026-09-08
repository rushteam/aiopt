import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSkillsStore, type SkillsStore } from '../skillsStore';
import { createNodeSkillsFs, SKILL_MARKER } from '../skillsFs';
import { AGENT_SKILL_DIRS } from '../../../shared/skills';
import { AGENT_IDS } from '../../../shared/aiProviders';
import { decodeIpcError, isIpcError } from '../../../shared/ipc-errors';
import type { AgentId } from '../../../shared/aiProviders';

let root: string;
let home: string;
let central: string;
let store: SkillsStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-skstore-'));
  home = path.join(root, 'home');
  central = path.join(root, 'central');
  fs.mkdirSync(home, { recursive: true });
  store = createSkillsStore({
    fs: createNodeSkillsFs(),
    homeDir: home,
    getLibraryLocation: () => 'app',
    centralDirFor: () => central,
    now: () => 1000,
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write a skill dir under an absolute base. */
function writeSkill(base: string, name: string, meta: string, files: Record<string, string> = {}): void {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SKILL_MARKER), meta);
  for (const [rel, contents] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }
}

function agentSkillsDir(agentId: AgentId): string {
  const rel = AGENT_SKILL_DIRS[agentId];
  if (rel === null) throw new Error('agent has no dir');
  return path.join(home, rel);
}

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (isIpcError(err)) return err.code;
    if (err instanceof Error) return decodeIpcError(err.message).code;
  }
  throw new Error('expected the call to throw a coded error');
}

describe('snapshot', () => {
  it('reports library location, a column per agent, and grok as unavailable', () => {
    const snap = store.snapshot();
    expect(snap.libraryLocation).toBe('app');
    expect(snap.scannedAt).toBe(1000);
    expect(snap.rows).toEqual([]);
    expect(snap.agents.map((a) => a.id).sort()).toEqual([...AGENT_IDS].sort());
    expect(snap.agents.find((a) => a.id === 'grok')?.available).toBe(false);
    expect(snap.agents.find((a) => a.id === 'claude')?.available).toBe(true);
  });

  it('classifies an agent-only skill', () => {
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\ndescription: d\n---\n');
    const snap = store.snapshot();
    const row = snap.rows.find((r) => r.name === 'foo');
    expect(row?.central).toBeNull();
    expect(row?.agents.claude?.state).toBe('agent-only');
    expect(row?.agents.claude?.entry?.meta).toEqual({ name: 'foo', description: 'd' });
  });

  it('classifies same vs differs after pull and edit', () => {
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n', { 'a.txt': '1' });
    store.pull('claude', 'foo');
    expect(store.snapshot().rows.find((r) => r.name === 'foo')?.agents.claude?.state).toBe('same');

    // Edit the agent copy so it diverges from central.
    fs.writeFileSync(path.join(agentSkillsDir('claude'), 'foo', 'a.txt'), 'changed');
    expect(store.snapshot().rows.find((r) => r.name === 'foo')?.agents.claude?.state).toBe('differs');
  });
});

describe('pull / push / delete', () => {
  it('pull copies an agent skill into central', () => {
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n', { 'ref/x.md': 'X' });
    store.pull('claude', 'foo');
    expect(fs.readFileSync(path.join(central, 'foo', 'ref/x.md'), 'utf8')).toBe('X');
  });

  it('push copies a central skill out to an agent', () => {
    writeSkill(central, 'bar', '---\nname: bar\n---\n', { 'y.md': 'Y' });
    store.push('bar', 'codex');
    expect(fs.readFileSync(path.join(agentSkillsDir('codex'), 'bar', 'y.md'), 'utf8')).toBe('Y');
  });

  it('deleteCentral removes the skill from central only', () => {
    writeSkill(central, 'bar', '---\nname: bar\n---\n');
    store.deleteCentral('bar');
    expect(fs.existsSync(path.join(central, 'bar'))).toBe(false);
  });

  it('reports NOT_FOUND when the source is absent', () => {
    expect(codeOf(() => store.pull('claude', 'ghost'))).toBe('NOT_FOUND');
    expect(codeOf(() => store.push('ghost', 'claude'))).toBe('NOT_FOUND');
    expect(codeOf(() => store.deleteCentral('ghost'))).toBe('NOT_FOUND');
  });

  it('rejects a bad name and an unknown/unsupported agent', () => {
    expect(codeOf(() => store.pull('claude', '../escape'))).toBe('INVALID_PARAMS');
    expect(codeOf(() => store.pull('bogus' as AgentId, 'foo'))).toBe('INVALID_PARAMS');
    expect(codeOf(() => store.pull('grok', 'foo'))).toBe('UNSUPPORTED_CAPABILITY');
  });
});

describe('diff', () => {
  it('returns per-file changes of the agent copy vs central', () => {
    writeSkill(central, 'foo', '---\nname: foo\n---\n', { 'keep.txt': 'k', 'gone.txt': 'g' });
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n', { 'keep.txt': 'k2', 'new.txt': 'n' });
    const result = store.diff('claude', 'foo');
    expect(result.name).toBe('foo');
    expect(result.agentId).toBe('claude');
    const byPath = Object.fromEntries(result.files.map((f) => [f.relPath, f.status]));
    expect(byPath['gone.txt']).toBe('added'); // in central, missing from agent
    expect(byPath['new.txt']).toBe('deleted'); // in agent, missing from central
    expect(byPath['keep.txt']).toBe('modified');
  });
});

describe('importFromDir', () => {
  it('imports a picked skill folder into central', () => {
    const src = path.join(root, 'external', 'imported');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, SKILL_MARKER), '---\nname: imported\n---\n');
    const name = store.importFromDir(src);
    expect(name).toBe('imported');
    expect(fs.existsSync(path.join(central, 'imported', SKILL_MARKER))).toBe(true);
  });

  it('rejects a folder without a SKILL.md', () => {
    const src = path.join(root, 'external', 'plain');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'readme.md'), 'not a skill');
    expect(codeOf(() => store.importFromDir(src))).toBe('INVALID_PARAMS');
  });

  it('rejects a missing source and a relative path', () => {
    expect(codeOf(() => store.importFromDir(path.join(root, 'nope')))).toBe('NOT_FOUND');
    expect(codeOf(() => store.importFromDir('relative/path'))).toBe('INVALID_PARAMS');
  });
});

describe('fileContent', () => {
  it('returns a differing file\'s content from the requested side', () => {
    writeSkill(central, 'foo', '---\nname: foo\n---\n', { 'a.txt': 'central' });
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n', { 'a.txt': 'agent' });
    expect(store.fileContent('claude', 'foo', 'central', 'a.txt').text).toBe('central');
    expect(store.fileContent('claude', 'foo', 'agent', 'a.txt').text).toBe('agent');
  });

  it('rejects a relPath that is not a differing file', () => {
    writeSkill(central, 'foo', '---\nname: foo\n---\n', { 'a.txt': 'x' });
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n', { 'a.txt': 'x' });
    // a.txt is identical → not in the diff → refused.
    expect(codeOf(() => store.fileContent('claude', 'foo', 'central', 'a.txt'))).toBe('INVALID_PARAMS');
    expect(codeOf(() => store.fileContent('claude', 'foo', 'central', 'ghost.txt'))).toBe('INVALID_PARAMS');
  });
});

describe('merge', () => {
  it('writes the picked agent files into central and leaves the agent copy untouched', () => {
    writeSkill(central, 'foo', '---\nname: foo\n---\n', { 'mod.txt': 'central', 'only-c.txt': 'c' });
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n', {
      'mod.txt': 'agent',
      'only-a.txt': 'a',
    });
    store.merge('claude', 'foo', ['mod.txt', 'only-a.txt', 'only-c.txt']);

    expect(fs.readFileSync(path.join(central, 'foo', 'mod.txt'), 'utf8')).toBe('agent');
    expect(fs.readFileSync(path.join(central, 'foo', 'only-a.txt'), 'utf8')).toBe('a');
    expect(fs.existsSync(path.join(central, 'foo', 'only-c.txt'))).toBe(false); // picked agent → dropped
    // Agent copy unchanged.
    const agentFoo = path.join(agentSkillsDir('claude'), 'foo');
    expect(fs.readFileSync(path.join(agentFoo, 'mod.txt'), 'utf8')).toBe('agent');
    expect(fs.existsSync(path.join(agentFoo, 'only-c.txt'))).toBe(false);
  });

  it('silently drops picks that are not in the diff', () => {
    writeSkill(central, 'foo', '---\nname: foo\n---\n', { 'mod.txt': 'central' });
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n', { 'mod.txt': 'agent' });
    store.merge('claude', 'foo', ['mod.txt', 'stale-unknown.txt']);
    expect(fs.readFileSync(path.join(central, 'foo', 'mod.txt'), 'utf8')).toBe('agent');
  });

  it('reports NOT_FOUND when either side is absent, and fires onChange on success', () => {
    writeSkill(central, 'foo', '---\nname: foo\n---\n', { 'mod.txt': 'central' });
    expect(codeOf(() => store.merge('claude', 'foo', []))).toBe('NOT_FOUND'); // agent absent

    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n', { 'mod.txt': 'agent' });
    let count = 0;
    store.onChange(() => {
      count += 1;
    });
    store.merge('claude', 'foo', ['mod.txt']);
    expect(count).toBe(1);
  });
});

describe('resolveRevealDir', () => {
  it('resolves central and agent targets', () => {
    expect(store.resolveRevealDir({ scope: 'central' })).toBe(path.resolve(central));
    expect(store.resolveRevealDir({ scope: 'central', name: 'foo' })).toBe(path.resolve(central, 'foo'));
    expect(store.resolveRevealDir({ scope: 'agent', agentId: 'claude' })).toBe(
      path.resolve(agentSkillsDir('claude')),
    );
    expect(codeOf(() => store.resolveRevealDir({ scope: 'agent', agentId: 'grok' }))).toBe(
      'UNSUPPORTED_CAPABILITY',
    );
  });
});

describe('onChange', () => {
  it('fires on mutating operations', () => {
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n');
    let count = 0;
    const off = store.onChange(() => {
      count += 1;
    });
    store.pull('claude', 'foo');
    expect(count).toBe(1);
    off();
    store.deleteCentral('foo');
    expect(count).toBe(1); // unsubscribed
  });
});
