// Application-menu command vocabulary — the single source of truth reused by all
// three sides:
//   • main builds the native menu and DISPATCHES one of these on click,
//   • preload runs `isMenuCommand` as a runtime allowlist so a spoofed push can
//     never smuggle an arbitrary string past the bridge,
//   • the renderer switches on the command to drive the UI.
//
// Only menu items that need the RENDERER to react live here (open Settings, run
// an update check, show About). Pure-native items (Quit, copy/paste, window
// roles) are handled by Electron roles and never cross to the renderer.

export const MENU_COMMANDS = {
  openSettings: 'open-settings',
  checkForUpdates: 'check-for-updates',
  showAbout: 'show-about',
} as const;

export type MenuCommand = (typeof MENU_COMMANDS)[keyof typeof MENU_COMMANDS];

const MENU_COMMAND_VALUES: ReadonlySet<string> = new Set(Object.values(MENU_COMMANDS));

/** Runtime allowlist guard — types are not runtime validation across the bridge. */
export function isMenuCommand(value: unknown): value is MenuCommand {
  return typeof value === 'string' && MENU_COMMAND_VALUES.has(value);
}
