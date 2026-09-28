// Shared layout for top-level tab screens (Providers / Skills / Usage / Workbench).
//
// Two modes:
//   · scroll — centered column, page scrolls (admin / browse surfaces)
//   · workspace — fills the viewport, internal panes scroll (Workbench)
//
// Keeps horizontal inset and top rhythm aligned so switching tabs does not jump.

import type { CSSProperties, ReactNode } from 'react';
import { space } from '../themes/tokens';

/** Horizontal inset and top offset under the title tab bar (px). */
export const TAB_SCREEN_INSET = space['2xl'];

/** Bottom inset on scroll screens — extra room when content extends past the viewport. */
export const TAB_SCREEN_SCROLL_BOTTOM = space['2xl'] * 2;

/** Bottom inset on workspace screens — matches side inset. */
export const TAB_SCREEN_WORKSPACE_BOTTOM = space['2xl'];

/** Default readable width for card/list screens. */
export const TAB_SCREEN_MAX_WIDTH = 880;

/** Wider column for data-heavy tables (skills sync matrix). */
export const TAB_SCREEN_MAX_WIDTH_WIDE = 980;

/** Primary intro line under the (visually hidden) page title. */
export const tabScreenIntroStyle: CSSProperties = {
  margin: `0 0 ${TAB_SCREEN_INSET}px`,
};

/** Secondary intro line stacked directly under the primary (e.g. usage scope note). */
export const tabScreenIntroSecondaryStyle: CSSProperties = {
  margin: `0 0 ${space.xs}px`,
};

/** Space between major sections on scroll screens. */
export const tabScreenSectionStyle: CSSProperties = {
  marginBottom: TAB_SCREEN_INSET + space.md,
};

const scrollInnerStyle = (maxWidth: number): CSSProperties => ({
  maxWidth,
  margin: '0 auto',
  padding: `${TAB_SCREEN_INSET}px ${TAB_SCREEN_INSET}px ${TAB_SCREEN_SCROLL_BOTTOM}px`,
});

const workspaceRootStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  gap: space.lg,
  padding: `${TAB_SCREEN_INSET}px ${TAB_SCREEN_INSET}px ${TAB_SCREEN_WORKSPACE_BOTTOM}px`,
  boxSizing: 'border-box',
};

export function ScrollTabScreen({
  maxWidth = TAB_SCREEN_MAX_WIDTH,
  children,
}: {
  maxWidth?: number;
  children: ReactNode;
}) {
  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={scrollInnerStyle(maxWidth)}>{children}</div>
    </div>
  );
}

export function WorkspaceTabScreen({ children }: { children: ReactNode }) {
  return <div style={workspaceRootStyle}>{children}</div>;
}
