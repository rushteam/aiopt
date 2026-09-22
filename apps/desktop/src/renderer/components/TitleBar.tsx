// The single top bar. It hosts navigation (TabBar: the three peer tabs + the
// settings gear) and, on macOS, the in-app hamburger menu — all on one row.
//
// On macOS the native title bar is hidden (main/window/mainWindow.ts uses
// `titleBarStyle: 'hidden'`), so the OS no longer gives us a drag handle and the
// inset traffic-light buttons overlap the top-left. This strip restores window
// dragging AND reserves the left inset so content clears the buttons; it also
// hosts the hamburger (MenuButton), the visible entry point for the native menu's
// renderer commands. On platforms that keep the native frame, there's no drag
// region and no hamburger (their OS menu bar already provides those commands) —
// the bar just carries the tabs and gear.

import type { CSSProperties } from 'react';
import { token } from '../themes/tokens';
import { MenuButton } from './title-bar/MenuButton';
import { TabBar, type AppTab } from './TabBar';
import type { MenuCommand } from '../../shared/menuCommands';

/** Tall enough to clear the traffic lights (inset at y:16). Matches Cindy's ~36px. */
const MAC_TITLEBAR_HEIGHT = 40;
/** Left inset that clears the three inset traffic-light buttons before app chrome. */
const MAC_TRAFFIC_LIGHT_INSET = 72;

// The app mark — the same four-pointed sparkle as assets/mark.svg (packaged
// icon), inlined here so the title bar carries the brand without an external
// asset (keeps it clear of the img-src CSP and Vite static handling). Purely
// decorative and non-interactive, so it stays inside the drag region.
function BrandMark() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <defs>
        <linearGradient id="titlebar-mark" x1="0.12" y1="0.08" x2="0.88" y2="0.92">
          <stop offset="0" stopColor="#8fb8ff" />
          <stop offset="0.42" stopColor="#5b8bff" />
          <stop offset="0.72" stopColor="#6d6bff" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <g transform="translate(256,256) scale(1.5)">
        <path
          d="M 0 -148 C 42 -14.7, 14.7 -42, 148 0 C 14.7 42, 42 14.7, 0 148 C -42 14.7, -14.7 42, -148 0 C -14.7 -42, -42 -14.7, 0 -148 Z"
          fill="url(#titlebar-mark)"
        />
      </g>
    </svg>
  );
}

export function TitleBar({
  onCommand,
  onQuit,
  tab,
  onSelectTab,
  settingsOpen,
}: {
  onCommand: (command: MenuCommand) => void;
  onQuit: () => void;
  tab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  settingsOpen: boolean;
}) {
  const isMac = window.aiopt.platform === 'darwin';
  const nav = <TabBar active={tab} onSelect={onSelectTab} settingsOpen={settingsOpen} />;

  return (
    <div
      style={
        {
          height: isMac ? MAC_TITLEBAR_HEIGHT : 44,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'stretch',
          gap: 8,
          // Clear the traffic lights on macOS; a normal gutter elsewhere.
          paddingLeft: isMac ? MAC_TRAFFIC_LIGHT_INSET : 16,
          paddingRight: 16,
          borderBottom: `1px solid ${token('border')}`,
          background: token('bg'),
          // The whole strip drags the window on macOS; interactive children opt out
          // with `no-drag`. No drag region where the native frame remains.
          ...(isMac ? { WebkitAppRegion: 'drag' } : {}),
        } as CSSProperties
      }
    >
      {/* A little left breathing room so the mark isn't flush against the gutter. */}
      <div style={{ display: 'flex', alignItems: 'center', marginLeft: 4 }}>
        <BrandMark />
      </div>
      {isMac && (
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <MenuButton onCommand={onCommand} onQuit={onQuit} />
        </div>
      )}
      {nav}
    </div>
  );
}
