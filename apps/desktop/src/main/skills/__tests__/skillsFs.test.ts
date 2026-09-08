import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeSkillsFs, parseSkillFrontmatter, SKILL_MARKER } from '../skillsFs';
import { SKILL_MAX_BYTES, SKILL_MAX_FILES } from '../../../shared/skills';
import { decodeIpcError, isIpcError } from '../../../shared/ipc-errors';

const skfs = createNodeSkillsFs();
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-skills-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write a skill directory `<base>/<name>` with a SKILL.md carrying the given frontmatter body. */
function makeSkill(base: string, name: string, frontmatter: string, extra: Record<string, string> = {}): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SKILL_MARKER), frontmatter);
  for (const [rel, contents] of Object.entries(extra)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }
  return dir;
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

describe('parseSkillFrontmatter', () => {
  it('extracts name and description', () => {
    const meta = parseSkillFrontmatter('---\nname: code-review\ndescription: Reviews code\n---\n# body\n');
    expect(meta).toEqual({ name: 'code-review', description: 'Reviews code' });
  });

  it('strips a single pair of surrounding quotes', () => {
    const meta = parseSkillFrontmatter('---\nname: "quoted"\ndescription: \'d\'\n---\n');
    expect(meta).toEqual({ name: 'quoted', description: 'd' });
  });

  it('tolerates CRLF and a leading BOM', () => {
    const meta = parseSkillFrontmatter('﻿---\r\nname: crlf\r\n---\r\n');
    expect(meta).toEqual({ name: 'crlf' });
  });

  it('returns null when there is no frontmatter or no name', () => {
    expect(parseSkillFrontmatter('# just a heading\n')).toBeNull();
    expect(parseSkillFrontmatter('---\ndescription: no name here\n---\n')).toBeNull();
  });
});

describe('listSkillNames', () => {
  it('lists only immediate subdirs containing SKILL.md, sorted', () => {
    makeSkill(root, 'beta', '---\nname: beta\n---\n');
    makeSkill(root, 'alpha', '---\nname: alpha\n---\n');
    fs.mkdirSync(path.join(root, 'not-a-skill'), { recursive: true }); // no SKILL.md
    fs.writeFileSync(path.join(root, 'loose.md'), 'x'); // a file, not a dir
    expect(skfs.listSkillNames(root)).toEqual(['alpha', 'beta']);
  });

  it('returns [] for a missing base directory', () => {
    expect(skfs.listSkillNames(path.join(root, 'nope'))).toEqual([]);
  });
});

describe('readMeta', () => {
  it('reads frontmatter, or null when name is missing', () => {
    const withName = makeSkill(root, 'a', '---\nname: a\ndescription: d\n---\n');
    const noName = makeSkill(root, 'b', '# no frontmatter\n');
    expect(skfs.readMeta(withName)).toEqual({ name: 'a', description: 'd' });
    expect(skfs.readMeta(noName)).toBeNull();
  });
});

describe('isSkillDir / hasMarker', () => {
  it('distinguishes a directory and a skill marker', () => {
    const dir = makeSkill(root, 's', '---\nname: s\n---\n');
    expect(skfs.isSkillDir(dir)).toBe(true);
    expect(skfs.hasMarker(dir)).toBe(true);

    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(skfs.isSkillDir(plain)).toBe(true);
    expect(skfs.hasMarker(plain)).toBe(false);

    expect(skfs.isSkillDir(path.join(root, 'absent'))).toBe(false);
  });
});

describe('measure', () => {
  it('counts files and bytes', () => {
    const dir = makeSkill(root, 's', '---\nname: s\n---\n', { 'ref/data.txt': 'hello' });
    const m = skfs.measure(dir);
    expect(m.fileCount).toBe(2);
    expect(m.totalBytes).toBeGreaterThan(0);
  });

  it('reports modifiedAt as the newest file mtime', () => {
    const dir = makeSkill(root, 's', '---\nname: s\n---\n', { 'ref/data.txt': 'hello' });
    const older = new Date('2020-01-01T00:00:00Z');
    const newer = new Date('2022-06-15T12:00:00Z');
    fs.utimesSync(path.join(dir, SKILL_MARKER), older, older);
    fs.utimesSync(path.join(dir, 'ref/data.txt'), newer, newer);
    expect(skfs.measure(dir).modifiedAt).toBe(newer.getTime());
  });

  it('refuses a symlink inside the skill', () => {
    const dir = makeSkill(root, 's', '---\nname: s\n---\n');
    fs.symlinkSync(os.homedir(), path.join(dir, 'link'));
    expect(codeOf(() => skfs.measure(dir))).toBe('PERMISSION_DENIED');
  });

  it('refuses too many files', () => {
    const dir = makeSkill(root, 's', '---\nname: s\n---\n');
    for (let i = 0; i <= SKILL_MAX_FILES; i += 1) fs.writeFileSync(path.join(dir, `f${i}`), 'x');
    expect(codeOf(() => skfs.measure(dir))).toBe('PRECONDITION_FAILED');
  });

  it('refuses an oversized skill', () => {
    const dir = makeSkill(root, 's', '---\nname: s\n---\n');
    fs.writeFileSync(path.join(dir, 'big'), Buffer.alloc(SKILL_MAX_BYTES + 1));
    expect(codeOf(() => skfs.measure(dir))).toBe('PRECONDITION_FAILED');
  });
});

describe('compare / differs', () => {
  it('reports added, deleted, and modified files', () => {
    const central = makeSkill(root, 'c', '---\nname: x\n---\n', { 'same.txt': 'eq', 'only-central.txt': 'c' });
    const agent = makeSkill(root, 'a', '---\nname: x\n---\n', { 'same.txt': 'eq', 'only-agent.txt': 'a' });
    // SKILL.md differs? no — identical. same.txt identical. modify one to force 'modified'.
    fs.writeFileSync(path.join(agent, 'same.txt'), 'changed');

    const diffs = skfs.compare(central, agent);
    const byPath = Object.fromEntries(diffs.map((d) => [d.relPath, d.status]));
    expect(byPath['only-central.txt']).toBe('added');
    expect(byPath['only-agent.txt']).toBe('deleted');
    expect(byPath['same.txt']).toBe('modified');
    expect(skfs.differs(central, agent)).toBe(true);
  });

  it('reports no differences for identical trees', () => {
    const central = makeSkill(root, 'c', '---\nname: x\n---\n', { 'a.txt': '1' });
    const agent = makeSkill(root, 'a', '---\nname: x\n---\n', { 'a.txt': '1' });
    expect(skfs.compare(central, agent)).toEqual([]);
    expect(skfs.differs(central, agent)).toBe(false);
  });

  it('flags binary files (NUL byte)', () => {
    const central = makeSkill(root, 'c', '---\nname: x\n---\n');
    fs.writeFileSync(path.join(central, 'bin'), Buffer.from([0x00, 0x01, 0x02]));
    const agent = makeSkill(root, 'a', '---\nname: x\n---\n');
    const diffs = skfs.compare(central, agent);
    const bin = diffs.find((d) => d.relPath === 'bin');
    expect(bin?.status).toBe('added');
    expect(bin?.binary).toBe(true);
  });
});

describe('replaceDir', () => {
  it('copies a source into a fresh destination', () => {
    const src = makeSkill(root, 'src', '---\nname: s\n---\n', { 'ref/a.txt': 'A' });
    const dst = path.join(root, 'dest', 's');
    skfs.replaceDir(src, dst);
    expect(fs.readFileSync(path.join(dst, SKILL_MARKER), 'utf8')).toContain('name: s');
    expect(fs.readFileSync(path.join(dst, 'ref/a.txt'), 'utf8')).toBe('A');
  });

  it('atomically overwrites an existing destination', () => {
    const src = makeSkill(root, 'src', '---\nname: new\n---\n', { 'new.txt': 'N' });
    const dst = makeSkill(root, 'dst', '---\nname: old\n---\n', { 'old.txt': 'O' });
    skfs.replaceDir(src, dst);
    expect(fs.readFileSync(path.join(dst, SKILL_MARKER), 'utf8')).toContain('name: new');
    expect(fs.existsSync(path.join(dst, 'new.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dst, 'old.txt'))).toBe(false); // replaced, not merged
  });

  it('refuses a source containing a symlink and leaves the destination untouched', () => {
    const src = makeSkill(root, 'src', '---\nname: s\n---\n');
    fs.symlinkSync(os.homedir(), path.join(src, 'escape'));
    const dst = makeSkill(root, 'dst', '---\nname: keep\n---\n');
    expect(codeOf(() => skfs.replaceDir(src, dst))).toBe('PERMISSION_DENIED');
    expect(fs.readFileSync(path.join(dst, SKILL_MARKER), 'utf8')).toContain('name: keep');
    // No half-written temp/old siblings left behind.
    expect(fs.readdirSync(path.dirname(dst)).filter((n) => n.includes('aiopt-'))).toEqual([]);
  });
});

describe('removeDir', () => {
  it('removes a directory and tolerates absence', () => {
    const dir = makeSkill(root, 's', '---\nname: s\n---\n');
    skfs.removeDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => skfs.removeDir(dir)).not.toThrow();
  });
});

describe('readTextFile', () => {
  const CAP = 1024;

  it('returns text for a small text file', () => {
    const dir = makeSkill(root, 's', '---\nname: s\n---\n', { 'ref/note.txt': 'hello world' });
    const got = skfs.readTextFile(dir, 'ref/note.txt', CAP);
    expect(got).toEqual({ text: 'hello world', binary: false, truncated: false });
  });

  it('flags a binary file and returns no text', () => {
    const dir = makeSkill(root, 's', '---\nname: s\n---\n');
    fs.writeFileSync(path.join(dir, 'bin'), Buffer.from([0x00, 0x01, 0x02]));
    expect(skfs.readTextFile(dir, 'bin', CAP)).toEqual({ text: null, binary: true, truncated: false });
  });

  it('truncates text past the cap and marks it', () => {
    const dir = makeSkill(root, 's', '---\nname: s\n---\n', { 'big.txt': 'x'.repeat(CAP + 50) });
    const got = skfs.readTextFile(dir, 'big.txt', CAP);
    expect(got.binary).toBe(false);
    expect(got.truncated).toBe(true);
    expect(got.text).toBe('x'.repeat(CAP));
  });

  it('returns null text for an absent file', () => {
    const dir = makeSkill(root, 's', '---\nname: s\n---\n');
    expect(skfs.readTextFile(dir, 'nope.txt', CAP)).toEqual({ text: null, binary: false, truncated: false });
  });

  it('refuses a path that escapes the skill directory', () => {
    const dir = makeSkill(root, 's', '---\nname: s\n---\n');
    expect(codeOf(() => skfs.readTextFile(dir, '../escape.txt', CAP))).toBe('PERMISSION_DENIED');
  });

  it('refuses a symlinked file', () => {
    const dir = makeSkill(root, 's', '---\nname: s\n---\n');
    fs.symlinkSync('/etc/hosts', path.join(dir, 'link.txt'));
    expect(codeOf(() => skfs.readTextFile(dir, 'link.txt', CAP))).toBe('PERMISSION_DENIED');
  });
});

describe('mergeInto', () => {
  it('copies agent-picked modified and agent-only files, drops picked central-only ones, keeps the rest', () => {
    const central = makeSkill(root, 'c', '---\nname: x\n---\n', {
      'same.txt': 'eq',
      'mod.txt': 'central',
      'only-central.txt': 'c',
    });
    const agent = makeSkill(root, 'a', '---\nname: x\n---\n', {
      'same.txt': 'eq',
      'mod.txt': 'agent',
      'only-agent.txt': 'a',
    });
    // Pick the agent side for: modified, the agent-only file, and the central-only file (→ drop it).
    skfs.mergeInto(central, agent, ['mod.txt', 'only-agent.txt', 'only-central.txt']);

    expect(fs.readFileSync(path.join(central, 'same.txt'), 'utf8')).toBe('eq'); // untouched
    expect(fs.readFileSync(path.join(central, 'mod.txt'), 'utf8')).toBe('agent'); // overwritten
    expect(fs.readFileSync(path.join(central, 'only-agent.txt'), 'utf8')).toBe('a'); // copied in
    expect(fs.existsSync(path.join(central, 'only-central.txt'))).toBe(false); // dropped
    // The agent copy is never modified by a merge.
    expect(fs.existsSync(path.join(agent, 'only-central.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(agent, 'mod.txt'), 'utf8')).toBe('agent');
  });

  it('leaves central files untouched when nothing is picked from the agent', () => {
    const central = makeSkill(root, 'c', '---\nname: x\n---\n', { 'mod.txt': 'central' });
    const agent = makeSkill(root, 'a', '---\nname: x\n---\n', { 'mod.txt': 'agent' });
    skfs.mergeInto(central, agent, []);
    expect(fs.readFileSync(path.join(central, 'mod.txt'), 'utf8')).toBe('central');
  });

  it('refuses a symlink on the agent side and leaves central intact', () => {
    const central = makeSkill(root, 'c', '---\nname: x\n---\n', { 'keep.txt': 'K' });
    const agent = makeSkill(root, 'a', '---\nname: x\n---\n', { 'mod.txt': 'agent' });
    fs.symlinkSync(os.homedir(), path.join(agent, 'escape'));
    expect(codeOf(() => skfs.mergeInto(central, agent, ['mod.txt']))).toBe('PERMISSION_DENIED');
    expect(fs.readFileSync(path.join(central, 'keep.txt'), 'utf8')).toBe('K');
    expect(fs.readdirSync(path.dirname(central)).filter((n) => n.includes('aiopt-'))).toEqual([]);
  });
});
