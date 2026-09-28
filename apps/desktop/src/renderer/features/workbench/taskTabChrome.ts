import type { CSSProperties } from 'react';
import { fontSize, radius, space, token } from '../../themes/tokens';

/** Width of the vertical task rail (tabs + summary). */
export const TASK_TAB_RAIL_WIDTH = 152;

/** Shared chrome height for horizontal task tabs (legacy strip). */
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

/** Inactive tab / tool control on a horizontal tab strip. */
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

/** Summary block at the top of the vertical rail. */
export function taskRailStatBlockStyle(): CSSProperties {
  return {
    flexShrink: 0,
    padding: `${space.sm}px ${space.md}px`,
    borderBottom: `1px solid ${token('border')}`,
    fontSize: fontSize.xs,
    fontVariantNumeric: 'tabular-nums',
    color: token('textMuted'),
    userSelect: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    lineHeight: 1.3,
  };
}

/** Icon control on a horizontal tab strip (+, ⋯). */
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

/** Footer control on the vertical rail (+, board menu). */
export function taskRailToolButtonStyle(overrides?: CSSProperties): CSSProperties {
  return {
    all: 'unset',
    boxSizing: 'border-box',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    minHeight: 28,
    borderRadius: radius.sm,
    border: `1px solid ${token('borderStrong')}`,
    background: token('bg'),
    fontSize: fontSize.sm,
    color: token('textMuted'),
    ...overrides,
  };
}
