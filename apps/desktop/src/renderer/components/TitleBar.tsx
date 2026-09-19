// Draggable window strip.
//
// On macOS the native title bar is hidden (main/window/mainWindow.ts uses
// `titleBarStyle: 'hidden'`), so the OS no longer gives us a drag handle and the
// inset traffic-light buttons overlap the top-left of the content. This strip
// restores window dragging AND reserves vertical space so app content starts
// below the buttons. It also hosts the in-app menu (see MenuButton), the visible
// entry point for the native menu's renderer commands. On platforms that keep the
// native frame it renders nothing (their OS menu bar already provides them).

import type { CSSProperties } from 'react';
import { MenuButton } from './title-bar/MenuButton';
import type { MenuCommand } from '../../shared/menuCommands';

/** Tall enough to clear the traffic lights (inset at y:16). Matches Cindy's ~36px. */
const MAC_TITLEBAR_HEIGHT = 38;
/** Left inset that clears the three inset traffic-light buttons before app chrome. */
const MAC_TRAFFIC_LIGHT_INSET = 72;

export function TitleBar({ onCommand }: { onCommand: (command: MenuCommand) => void }) {
  if (window.aiopt.platform !== 'darwin') return null;
  return (
    <div
      style={
        {
          height: MAC_TITLEBAR_HEIGHT,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          // Leave room for the traffic lights, then the menu button.
          paddingLeft: MAC_TRAFFIC_LIGHT_INSET,
          paddingRight: 8,
          // The whole strip drags the window; interactive children (MenuButton)
          // opt out with `WebkitAppRegion: 'no-drag'`.
          WebkitAppRegion: 'drag',
        } as CSSProperties
      }
    >
      <MenuButton onCommand={onCommand} />
    </div>
  );
}
