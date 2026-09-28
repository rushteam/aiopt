import type { CSSProperties } from 'react';
import { fontSize, radius, token } from '../../themes/tokens';

/** Shared chrome height for task tabs and row controls (Chrome-style tab strip). */
export const TASK_TAB_HEIGHT = 30;
export const TASK_TAB_MARGIN_TOP = 4;
export const TASK_TAB_MARGIN_BOTTOM = -1;

const tabTopRadius = `${radius.sm}px ${radius.sm}px 0 0`;

const tabStripLift: CSSProperties = {
  marginTop: TASK_TAB_MARGIN_TOP,
  marginBottom: TASK_TAB_MARGIN_BOTTOM,
  height: TASK_TAB_HEIGHT,
  boxSizing: 'border-box',
};

/** Inactive tab / tool control on the tab strip. */
export function taskTabInactiveChrome(overrides?: CSSProperties): CSSProperties {
  return {
    ...tabStripLift,
    borderRadius: tabTopRadius,
    border: `1px solid ${token('borderStrong')}`,
    borderBottom: `1px solid ${token('border')}`,
    background: token('bg'),
    ...overrides,
  };
}

/** Left summary chip (task count · live slots). */
export function taskTabStatChipStyle(): CSSProperties {
  return {
    ...taskTabInactiveChrome(),
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    flexShrink: 0,
    padding: '0 10px',
    fontSize: fontSize.sm,
    fontVariantNumeric: 'tabular-nums',
    color: token('textMuted'),
    userSelect: 'none',
  };
}

/** Icon-sized control on the right (+, ⋯). */
export function taskTabToolButtonStyle(overrides?: CSSProperties): CSSProperties {
  return {
    all: 'unset',
    ...taskTabInactiveChrome(),
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    flexShrink: 0,
    color: token('textMuted'),
    ...overrides,
  };
}
