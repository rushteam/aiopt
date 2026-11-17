import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SkillMeta } from '../../../shared/skills';
import {
  SKILL_DESCRIPTION_MAX,
  WORKBENCH_SKILLS_MAX,
  isSkillCommandName,
  scanSkillLibrary,
  skillCommandLine,
  skillViews,
  workerSkillArgs,
  type SkillLibraryFs,
} from '../workbenchSkills';

const LIB = path.join('/lib', 'skills');

function libFs(entries: Record<string, SkillMeta | null>): SkillLibraryFs {
  return {
    listSkillNames: (dir) => (dir === LIB ? Object.keys(entries) : []),
    readMeta: (dir) => entries[path.basename(dir)] ?? null,
  };
}

const meta = (name: string, description?: string): SkillMeta => ({ name, description }) as SkillMeta;

describe('scanSkillLibrary', () => {
  it('keeps loadable skills, sorted, and drops what pi would not load', () => {
    const scan = scanSkillLibrary(
      libFs({
        zeta: meta('zeta', 'Last'),
        alpha: meta('alpha', 'First\n  line'),
        nodesc: meta('nodesc'),
        blank: meta('blank', '  '),
        broken: null,
        Upper: meta('Upper', 'bad name'),
        'dup-a': meta('alpha', 'Same name as alpha'),
        '..': meta('evil', 'traversal'),
      }),
      LIB,
      path.join,
      false,
    );
    expect(scan.skills).toEqual([
      { name: 'alpha', description: 'First line', dir: path.join(LIB, 'alpha') },
      { name: 'zeta', description: 'Last', dir: path.join(LIB, 'zeta') },
    ]);
  });

  it('bounds descriptions and the number of skills', () => {
    const entries: Record<string, SkillMeta> = {};
    for (let i = 0; i < WORKBENCH_SKILLS_MAX + 5; i += 1) entries[`s${i}`] = meta(`s${i}`, 'x'.repeat(2000));
    const scan = scanSkillLibrary(libFs(entries), LIB, path.join, false);
    expect(scan.skills).toHaveLength(WORKBENCH_SKILLS_MAX);
    expect(scan.skills[0]!.description).toHaveLength(SKILL_DESCRIPTION_MAX);
    expect(scan.skills[0]!.description.endsWith('…')).toBe(true);
  });
});

describe('workerSkillArgs', () => {
  const scan = { autoDiscovered: false, skills: [{ name: 'a', description: 'd', dir: '/lib/a' }] };
  it('passes each skill directory, none when pi finds the library itself, and --no-skills when off', () => {
    expect(workerSkillArgs(scan, true)).toEqual(['--skill', '/lib/a']);
    expect(workerSkillArgs({ ...scan, autoDiscovered: true }, true)).toEqual([]);
    expect(workerSkillArgs(scan, false)).toEqual(['--no-skills']);
  });
  it('sends the renderer names and descriptions only', () => {
    expect(skillViews(scan)).toEqual([{ name: 'a', description: 'd' }]);
  });
});

describe('skill command names and prompts', () => {
  it('accepts pi command names only', () => {
    expect(isSkillCommandName('code-review')).toBe(true);
    for (const bad of ['', 'A', '-a', 'a-', 'a--b', 'a b', 'x'.repeat(65), 7])
      expect(isSkillCommandName(bad)).toBe(false);
  });
  it('joins a request on the next line to the command with a space', () => {
    expect(skillCommandLine('/skill:review\n\n  check src')).toBe('/skill:review check src');
    expect(skillCommandLine('/skill:review check src')).toBe('/skill:review check src');
    expect(skillCommandLine('please /skill:review\nx')).toBe('please /skill:review\nx');
  });
});
