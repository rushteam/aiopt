import { describe, expect, it } from 'vitest';
import {
  WORKBENCH_SPLIT_DEFAULT,
  clampSplitRatioToWidth,
  clampWorkbenchSplitRatio,
} from '../workbenchSplit';

describe('workbenchSplit', () => {
  it('clamps stored ratio to sane bounds', () => {
    expect(clampWorkbenchSplitRatio(0)).toBeGreaterThan(0);
    expect(clampWorkbenchSplitRatio(1)).toBeLessThan(1);
    expect(clampWorkbenchSplitRatio(Number.NaN)).toBe(WORKBENCH_SPLIT_DEFAULT);
  });

  it('respects minimum pane widths when the window is wide enough', () => {
    expect(clampSplitRatioToWidth(0.5, 1200)).toBeCloseTo(0.5, 2);
    expect(clampSplitRatioToWidth(0.05, 1200)).toBeGreaterThan(0.2);
    expect(clampSplitRatioToWidth(0.95, 1200)).toBeLessThan(0.8);
  });
});
