import { describe, expect, it } from 'vitest';
import {
  appShortcutCombosEqual,
  appShortcutScopesOverlap,
  comboToElectronAccelerator,
  createAppShortcutComboFromEvent,
  findAppShortcutConflict,
  formatAppShortcutCombo,
  getEffectiveAppShortcuts,
  isAppShortcutComboBindable,
  isAppShortcutId,
  matchesKeyboardEvent,
  normalizeAppShortcutCombo,
  normalizeAppShortcutOverrides,
  type AppShortcutCombo,
} from '../appShortcuts';

function mk(code: string, mods: Partial<AppShortcutCombo> = {}): AppShortcutCombo {
  return {
    code,
    meta: Boolean(mods.meta),
    ctrl: Boolean(mods.ctrl),
    alt: Boolean(mods.alt),
    shift: Boolean(mods.shift),
  };
}

describe('normalizeAppShortcutCombo', () => {
  it('rejects non-objects and modifier-only codes', () => {
    expect(normalizeAppShortcutCombo(null)).toBeNull();
    expect(normalizeAppShortcutCombo('x')).toBeNull();
    expect(normalizeAppShortcutCombo({ code: 'MetaLeft', meta: true })).toBeNull();
    expect(normalizeAppShortcutCombo({ code: '' })).toBeNull();
  });

  it('coerces missing modifiers to false and keeps the code', () => {
    expect(normalizeAppShortcutCombo({ code: 'KeyJ', meta: true })).toEqual({
      code: 'KeyJ',
      key: undefined,
      meta: true,
      ctrl: false,
      alt: false,
      shift: false,
    });
  });
});

describe('getEffectiveAppShortcuts (defaults + overrides)', () => {
  it('returns the darwin defaults when there are no overrides', () => {
    const map = getEffectiveAppShortcuts({}, 'darwin');
    expect(map.get('open-settings')).toEqual([mk('Comma', { meta: true })]);
    expect(map.get('check-for-updates')).toEqual([mk('KeyU', { meta: true })]);
    expect(map.get('toggle-theme')).toEqual([mk('KeyL', { meta: true, shift: true })]);
  });

  it('uses Ctrl instead of Command off darwin', () => {
    const map = getEffectiveAppShortcuts({}, 'win32');
    expect(map.get('open-settings')).toEqual([mk('Comma', { ctrl: true })]);
  });

  it('an override replaces the default list; null disables (empty list)', () => {
    const rebind = getEffectiveAppShortcuts({ 'toggle-theme': mk('KeyJ', { meta: true }) }, 'darwin');
    expect(rebind.get('toggle-theme')).toEqual([mk('KeyJ', { meta: true })]);
    const disabled = getEffectiveAppShortcuts({ 'toggle-theme': null }, 'darwin');
    expect(disabled.get('toggle-theme')).toEqual([]);
  });
});

describe('normalizeAppShortcutOverrides', () => {
  it('drops unknown ids and invalid combos, keeps valid rebinds + nulls', () => {
    const result = normalizeAppShortcutOverrides(
      {
        'toggle-theme': { code: 'KeyJ', meta: true },
        'open-settings': null,
        'not-a-real-id': { code: 'KeyK', meta: true },
        'check-for-updates': { code: 'MetaLeft', meta: true }, // modifier-only → invalid
      },
      'darwin',
    );
    expect(result).toEqual({
      'toggle-theme': mk('KeyJ', { meta: true }),
      'open-settings': null,
    });
  });
});

describe('comboToElectronAccelerator', () => {
  it('emits Command on darwin and Super elsewhere; null for unmappable codes', () => {
    expect(comboToElectronAccelerator(mk('Comma', { meta: true }), 'darwin')).toBe('Command+,');
    expect(comboToElectronAccelerator(mk('Comma', { ctrl: true }), 'win32')).toBe('Ctrl+,');
    expect(comboToElectronAccelerator(mk('KeyL', { meta: true, shift: true }), 'darwin')).toBe(
      'Shift+Command+L',
    );
    // A code with no accelerator mapping degrades to null (menu shows nothing).
    expect(comboToElectronAccelerator(mk('IntlBackslash', { meta: true }), 'darwin')).toBeNull();
  });
});

describe('isAppShortcutComboBindable (bare-key limit)', () => {
  it('allows a function key or any modifier combo, rejects bare/printable-shift keys', () => {
    expect(isAppShortcutComboBindable(mk('KeyA'))).toBe(false); // bare letter
    expect(isAppShortcutComboBindable(mk('F5'))).toBe(true); // bare function key
    expect(isAppShortcutComboBindable(mk('KeyA', { shift: true }))).toBe(false); // Shift+letter is typing
    expect(isAppShortcutComboBindable(mk('Tab', { shift: true }))).toBe(true); // Shift+non-printing OK
    expect(isAppShortcutComboBindable(mk('KeyA', { meta: true }))).toBe(true);
  });
});

describe('findAppShortcutConflict', () => {
  it('detects a collision with another shortcut in an overlapping scope', () => {
    // Binding toggle-theme to open-settings' default ⌘, collides.
    expect(
      findAppShortcutConflict('toggle-theme', mk('Comma', { meta: true }), {}, 'darwin'),
    ).toBe('open-settings');
    // A free combo has no conflict.
    expect(findAppShortcutConflict('toggle-theme', mk('KeyJ', { meta: true }), {}, 'darwin')).toBeNull();
  });
});

describe('matching + display + misc', () => {
  it('matchesKeyboardEvent compares code + all four modifiers', () => {
    const combo = mk('KeyU', { meta: true });
    expect(
      matchesKeyboardEvent(
        { code: 'KeyU', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
        combo,
      ),
    ).toBe(true);
    expect(
      matchesKeyboardEvent(
        { code: 'KeyU', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
        combo,
      ),
    ).toBe(false);
  });

  it('formats mac glyphs with no separator and Ctrl+…+Key elsewhere', () => {
    expect(formatAppShortcutCombo(mk('KeyL', { meta: true, shift: true }), 'darwin')).toBe('⇧⌘L');
    expect(formatAppShortcutCombo(mk('Comma', { ctrl: true }), 'win32')).toBe('Ctrl+,');
  });

  it('createAppShortcutComboFromEvent ignores a pure-modifier press', () => {
    expect(
      createAppShortcutComboFromEvent({
        code: 'MetaLeft',
        key: 'Meta',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
  });

  it('isAppShortcutId + scope overlap + combo equality', () => {
    expect(isAppShortcutId('toggle-theme')).toBe(true);
    expect(isAppShortcutId('nope')).toBe(false);
    expect(appShortcutScopesOverlap('app', 'editor')).toBe(true);
    expect(appShortcutScopesOverlap('editor', 'editor')).toBe(true);
    expect(appShortcutCombosEqual(mk('KeyJ', { meta: true }), mk('KeyJ', { meta: true }))).toBe(true);
    expect(appShortcutCombosEqual(mk('KeyJ', { meta: true }), mk('KeyJ'))).toBe(false);
  });
});
