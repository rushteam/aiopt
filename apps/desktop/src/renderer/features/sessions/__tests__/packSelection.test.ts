import { describe, expect, it } from 'vitest';
import { packIndexes, toggleSelection } from '../packSelection';

const visible = [0, 2, 3, 5, 6];

describe('pack selection', () => {
  it('toggles one message', () => {
    const on = toggleSelection(new Set(), 2, { range: false, anchor: null, visible });
    expect([...on]).toEqual([2]);
    expect([...toggleSelection(on, 2, { range: false, anchor: 2, visible })]).toEqual([]);
  });

  it('shift-picks the visible range following the anchor state', () => {
    const picked = toggleSelection(new Set([2]), 6, { range: true, anchor: 2, visible });
    expect([...picked].sort((a, b) => a - b)).toEqual([2, 3, 5, 6]);
    const cleared = toggleSelection(new Set([0, 2, 3]), 3, { range: true, anchor: 5, visible });
    expect([...cleared].sort((a, b) => a - b)).toEqual([0, 2]);
  });

  it('packs only visible picks, in order', () => {
    expect(packIndexes(new Set([6, 1, 0]), visible)).toEqual([0, 6]);
  });
});
