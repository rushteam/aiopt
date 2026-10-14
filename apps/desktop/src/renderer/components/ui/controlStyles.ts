import type { CSSProperties } from 'react';
import { controlHeight, controlPaddingX, fontSize, radius, token } from '../../themes/tokens';

export type ControlSize = 'sm' | 'md';

/** Box metrics shared by buttons, select triggers, and segmented segments. */
export function inlineControlBox(size: ControlSize): CSSProperties {
  const h = controlHeight[size];
  const px = controlPaddingX[size];
  return {
    height: h,
    minHeight: h,
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: `0 ${px}px`,
    fontSize: size === 'sm' ? fontSize.sm : fontSize.md,
    lineHeight: 1,
  };
}

/** Width of {@link segmentedRootStyle}'s border, top and bottom. */
const SEGMENTED_BORDER = 1;

export const segmentedRootStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'stretch',
  border: `${SEGMENTED_BORDER}px solid ${token('borderStrong')}`,
  borderRadius: radius.md,
  overflow: 'hidden',
};

export function segmentButtonChrome(size: ControlSize = 'md'): CSSProperties {
  // The root's border wraps the segments, so each segment gives up that border's height:
  // the whole control then stands at controlHeight[size], level with a button beside it.
  const h = controlHeight[size] - 2 * SEGMENTED_BORDER;
  return {
    ...inlineControlBox(size),
    height: h,
    minHeight: h,
    border: 'none',
    borderRadius: 0,
    background: 'transparent',
    cursor: 'pointer',
  };
}

export function buttonAccentChrome(size: ControlSize = 'md'): CSSProperties {
  return {
    ...inlineControlBox(size),
    borderRadius: radius.md,
    border: `1px solid ${token('accent')}`,
    background: token('accent'),
    color: token('accentText'),
    cursor: 'pointer',
  };
}

export function buttonGhostChrome(size: ControlSize = 'md'): CSSProperties {
  return {
    ...inlineControlBox(size),
    borderRadius: radius.md,
    border: `1px solid ${token('borderStrong')}`,
    background: 'transparent',
    color: token('text'),
    cursor: 'pointer',
  };
}

/** Shared text-field chrome — height matches {@link controlHeight}. */
export const controlInputStyle: CSSProperties = {
  ...inlineControlBox('md'),
  justifyContent: 'flex-start',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: token('surface'),
  color: token('text'),
  width: '100%',
};

export const controlInputSmStyle: CSSProperties = {
  ...inlineControlBox('sm'),
  justifyContent: 'flex-start',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: token('surface'),
  color: token('text'),
  width: '100%',
};
