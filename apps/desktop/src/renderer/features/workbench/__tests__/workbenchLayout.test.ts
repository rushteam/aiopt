import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_LAYOUT,
  EXPLORER_WIDTH,
  SIDEBAR_WIDTH,
  clampWidth,
  parseWorkbenchLayout,
} from '../workbenchLayout';

describe('workbenchLayout', () => {
  it('falls back to the default for missing or malformed storage', () => {
    expect(parseWorkbenchLayout(null)).toEqual(DEFAULT_WORKBENCH_LAYOUT);
    expect(parseWorkbenchLayout('not json')).toEqual(DEFAULT_WORKBENCH_LAYOUT);
    expect(parseWorkbenchLayout('42')).toEqual(DEFAULT_WORKBENCH_LAYOUT);
    expect(DEFAULT_WORKBENCH_LAYOUT.explorerCollapsed).toBe(true);
  });

  it('keeps valid fields and repairs bad ones individually', () => {
    const parsed = parseWorkbenchLayout(
      JSON.stringify({ sidebarWidth: 9999, sidebarCollapsed: true, explorerWidth: 'wide', explorerCollapsed: false }),
    );
    expect(parsed).toEqual({
      sidebarWidth: SIDEBAR_WIDTH.max,
      sidebarCollapsed: true,
      explorerWidth: EXPLORER_WIDTH.default,
      explorerCollapsed: false,
    });
  });

  it('clamps widths to their bounds', () => {
    expect(clampWidth(10, SIDEBAR_WIDTH)).toBe(SIDEBAR_WIDTH.min);
    expect(clampWidth(250.6, SIDEBAR_WIDTH)).toBe(251);
    expect(clampWidth(Number.NaN, EXPLORER_WIDTH)).toBe(EXPLORER_WIDTH.default);
  });
});
