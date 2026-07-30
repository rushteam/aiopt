import { describe, expect, it } from 'vitest';
import { SHORTCUTS, SHORTCUT_LIST, formatAccelerator } from '../shortcuts';
import { isMenuCommand } from '../menuCommands';

describe('shortcut registry', () => {
  it('has unique ids and unique accelerators', () => {
    const ids = SHORTCUT_LIST.map((s) => s.id);
    const accelerators = SHORTCUT_LIST.map((s) => s.accelerator);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(accelerators).size).toBe(accelerators.length);
  });

  it('maps every command-bearing shortcut to a real menu command', () => {
    for (const shortcut of SHORTCUT_LIST) {
      if (shortcut.command !== undefined) {
        expect(isMenuCommand(shortcut.command)).toBe(true);
      }
    }
  });

  it('binds the same accelerator the menu uses for Settings / Check for Updates', () => {
    // These accelerators are the single source consumed by appMenu.ts.
    expect(SHORTCUTS.openSettings.accelerator).toBe('CmdOrCtrl+,');
    expect(SHORTCUTS.checkForUpdates.accelerator).toBe('CmdOrCtrl+U');
  });

  it('formats accelerators per platform for display only', () => {
    expect(formatAccelerator('CmdOrCtrl+,', true)).toBe('⌘,');
    expect(formatAccelerator('CmdOrCtrl+,', false)).toBe('Ctrl+,');
    expect(formatAccelerator('CmdOrCtrl+Shift+U', true)).toBe('⌘⇧U');
  });
});
