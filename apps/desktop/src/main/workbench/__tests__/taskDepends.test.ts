import { describe, expect, it } from 'vitest';
import { dependenciesMet, normalizeDependsOnIds, wouldCreateCycle } from '../taskDepends';

describe('taskDepends', () => {
  it('normalizes ids against a known set', () => {
    const known = new Set(['a1', 'b2']);
    expect(normalizeDependsOnIds(['a1', 'b2', 'nope', 'a1'], known, 'a1')).toEqual(['b2']);
  });

  it('requires every dependency to be done', () => {
    const tasks = new Map([
      ['a', { status: 'done' as const }],
      ['b', { status: 'working' as const }],
    ]);
    expect(dependenciesMet(['a'], tasks)).toBe(true);
    expect(dependenciesMet(['a', 'b'], tasks)).toBe(false);
    expect(dependenciesMet([], tasks)).toBe(true);
  });

  it('detects cycles', () => {
    const edges = new Map([
      ['b', ['a']],
      ['c', ['b']],
    ]);
    expect(wouldCreateCycle('a', ['c'], edges)).toBe(true);
    expect(wouldCreateCycle('d', ['c'], edges)).toBe(false);
    expect(wouldCreateCycle('x', ['x'], new Map())).toBe(true);
  });
});
