import { describe, expect, it } from 'vitest';
import { MENU_COMMANDS, isMenuCommand } from '../menuCommands';

describe('menu command allowlist', () => {
  it('accepts every declared command', () => {
    for (const command of Object.values(MENU_COMMANDS)) {
      expect(isMenuCommand(command)).toBe(true);
    }
  });

  it('rejects anything not in the allowlist', () => {
    for (const bad of ['', 'quit', 'open-settings ', 'OPEN-SETTINGS', 'delete-everything', 42, null, undefined, {}]) {
      expect(isMenuCommand(bad)).toBe(false);
    }
  });
});
