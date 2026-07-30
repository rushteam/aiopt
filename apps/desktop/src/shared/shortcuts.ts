// Keyboard-shortcut registry — the single source of truth for app accelerators.
//
// The native menu (main/menu/appMenu.ts) binds these accelerators AND the
// renderer's Shortcuts settings page lists them, both from HERE — so the two can
// never drift. A shortcut that triggers a menu command carries that command, so
// the mapping is explicit and testable.

import { MENU_COMMANDS, type MenuCommand } from './menuCommands';

export interface ShortcutDef {
  /** Stable id; also the i18n key under `shortcuts.items`. */
  id: string;
  /** Electron accelerator string — the exact value the native menu binds. */
  accelerator: string;
  /** The menu command this shortcut activates, when it maps to one. */
  command?: MenuCommand;
}

export const SHORTCUTS = {
  openSettings: {
    id: 'openSettings',
    accelerator: 'CmdOrCtrl+,',
    command: MENU_COMMANDS.openSettings,
  },
  checkForUpdates: {
    id: 'checkForUpdates',
    accelerator: 'CmdOrCtrl+U',
    command: MENU_COMMANDS.checkForUpdates,
  },
} as const satisfies Record<string, ShortcutDef>;

export type ShortcutId = keyof typeof SHORTCUTS;

export const SHORTCUT_LIST: readonly ShortcutDef[] = Object.values(SHORTCUTS);

/**
 * Render an accelerator for display. Electron's `CmdOrCtrl` etc. are binding
 * tokens, not user-facing labels; this turns them into the glyphs/words a user
 * expects for their platform. Purely presentational — the binding stays in
 * `accelerator`.
 */
export function formatAccelerator(accelerator: string, isMac: boolean): string {
  const parts = accelerator.split('+').map((part) => {
    switch (part) {
      case 'CmdOrCtrl':
      case 'CommandOrControl':
        return isMac ? '⌘' : 'Ctrl';
      case 'Cmd':
      case 'Command':
        return '⌘';
      case 'Ctrl':
      case 'Control':
        return isMac ? '⌃' : 'Ctrl';
      case 'Alt':
      case 'Option':
        return isMac ? '⌥' : 'Alt';
      case 'Shift':
        return isMac ? '⇧' : 'Shift';
      default:
        return part;
    }
  });
  return parts.join(isMac ? '' : '+');
}
