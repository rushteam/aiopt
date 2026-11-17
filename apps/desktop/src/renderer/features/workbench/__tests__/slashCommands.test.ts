import { describe, expect, it } from 'vitest';
import { activeSlashQuery, slashOptions } from '../slashCommands';

const skills = [
  { name: 'code-review', description: 'Review a diff' },
  { name: 'release', description: 'Cut a release' },
  { name: 'pre-release-check', description: 'Check before release' },
];
const run = (): void => {};

describe('activeSlashQuery', () => {
  it('opens only for a leading command word under the caret', () => {
    expect(activeSlashQuery('/', 1)).toEqual({ start: 0, query: '' });
    expect(activeSlashQuery('/skill:co', 9)).toEqual({ start: 0, query: 'skill:co' });
    expect(activeSlashQuery('/rev more', 9)).toBeNull();
    expect(activeSlashQuery('a /rev', 6)).toBeNull();
    expect(activeSlashQuery('/usr/bin', 8)).toBeNull();
    expect(activeSlashQuery('/x', 0)).toBeNull();
  });
});

describe('slashOptions', () => {
  it('lists app commands before skills, best match first', () => {
    const out = slashOptions('re', [{ name: 'new', description: 'New', run }], skills);
    expect(out.map((o) => o.token)).toEqual(['/skill:release', '/skill:code-review', '/skill:pre-release-check']);
    const all = slashOptions('', [{ name: 'new', description: 'New', run }], skills);
    expect(all[0]).toMatchObject({ kind: 'command', token: '/new' });
    expect(all[0]!.run).toBe(run);
    expect(all.slice(1).every((o) => o.kind === 'skill' && o.run === undefined)).toBe(true);
  });
  it('treats a typed skill: prefix as skills only', () => {
    const out = slashOptions('skill:', [{ name: 'new', description: 'New', run }], skills);
    expect(out.every((o) => o.kind === 'skill')).toBe(true);
    expect(slashOptions('skill:code', [], skills).map((o) => o.label)).toEqual(['code-review']);
  });
});
