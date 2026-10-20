import { describe, expect, it } from 'vitest';
import { estimateTextHeight, FOLLOW_THRESHOLD_PX, nextFollow, prefixOffsets, rowAt, visibleRange } from '../virtualList';

describe('virtualList', () => {
  const offsets = prefixOffsets([100, 50, 200, 10]);

  it('builds prefix offsets', () => {
    expect(offsets).toEqual([0, 100, 150, 350, 360]);
  });

  it('finds the row under a y', () => {
    expect(rowAt(offsets, 0)).toBe(0);
    expect(rowAt(offsets, 99)).toBe(0);
    expect(rowAt(offsets, 100)).toBe(1);
    expect(rowAt(offsets, 349)).toBe(2);
    expect(rowAt(offsets, 9999)).toBe(3);
    expect(rowAt([0], 10)).toBe(0);
  });

  it('draws the viewport plus overscan', () => {
    expect(visibleRange(offsets, 120, 20, 0)).toEqual({ start: 1, end: 2 });
    expect(visibleRange(offsets, 120, 20, 40)).toEqual({ start: 0, end: 3 });
    expect(visibleRange([0], 0, 100, 100)).toEqual({ start: 0, end: 0 });
  });

  it('follows near the bottom and stops when the user scrolls up', () => {
    expect(nextFollow({ distanceFromBottom: 0, movedUp: true, following: false })).toBe(true);
    expect(nextFollow({ distanceFromBottom: 50, movedUp: true, following: true })).toBe(false);
    expect(nextFollow({ distanceFromBottom: 50, movedUp: false, following: false })).toBe(true);
    expect(nextFollow({ distanceFromBottom: FOLLOW_THRESHOLD_PX + 10, movedUp: false, following: false })).toBe(false);
    expect(nextFollow({ distanceFromBottom: FOLLOW_THRESHOLD_PX + 10, movedUp: false, following: true })).toBe(true);
  });

  it('estimates wrapped text height', () => {
    expect(estimateTextHeight('', 10, 20, 0)).toBe(20);
    expect(estimateTextHeight('a'.repeat(25), 10, 20, 0)).toBe(60);
    expect(estimateTextHeight('a\nb', 10, 20, 4)).toBe(44);
  });
});
