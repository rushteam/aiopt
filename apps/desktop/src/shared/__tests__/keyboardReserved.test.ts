import { describe, expect, it } from 'vitest';
import {
  isMacReservedShortcut,
  isSystemReservedShortcut,
  isWindowsReservedShortcut,
  type ReservedShortcutInput,
} from '../keyboardReserved';

function inp(code: string, mods: Partial<ReservedShortcutInput> = {}): ReservedShortcutInput {
  return {
    code,
    meta: Boolean(mods.meta),
    ctrl: Boolean(mods.ctrl),
    alt: Boolean(mods.alt),
    shift: Boolean(mods.shift),
  };
}

describe('isMacReservedShortcut', () => {
  it('reserves system editing + menu-role accelerators', () => {
    expect(isMacReservedShortcut(inp('KeyC', { meta: true }))).toBe(true); // ⌘C
    expect(isMacReservedShortcut(inp('Comma', { meta: true }))).toBe(true); // ⌘,
    expect(isMacReservedShortcut(inp('KeyZ', { meta: true, shift: true }))).toBe(true); // ⇧⌘Z
    expect(isMacReservedShortcut(inp('KeyF', { meta: true, ctrl: true }))).toBe(true); // ⌃⌘F
  });

  it('does not reserve a free combo like ⌘J or ⇧⌘L', () => {
    expect(isMacReservedShortcut(inp('KeyJ', { meta: true }))).toBe(false);
    expect(isMacReservedShortcut(inp('KeyL', { meta: true, shift: true }))).toBe(false);
  });
});

describe('isWindowsReservedShortcut', () => {
  it('reserves the Alt+Tab family and Win-key combos', () => {
    expect(isWindowsReservedShortcut(inp('Tab', { alt: true }))).toBe(true);
    expect(isWindowsReservedShortcut(inp('KeyL', { meta: true }))).toBe(true); // Win+L lock
    expect(isWindowsReservedShortcut(inp('Delete', { ctrl: true, alt: true }))).toBe(true);
  });

  it('does not reserve plain Ctrl+J', () => {
    expect(isWindowsReservedShortcut(inp('KeyJ', { ctrl: true }))).toBe(false);
  });
});

describe('isSystemReservedShortcut (platform dispatch)', () => {
  it('routes to the right family and reserves nothing on other platforms', () => {
    expect(isSystemReservedShortcut(inp('KeyC', { meta: true }), 'mac')).toBe(true);
    expect(isSystemReservedShortcut(inp('Tab', { alt: true }), 'windows')).toBe(true);
    expect(isSystemReservedShortcut(inp('KeyC', { meta: true }), 'other')).toBe(false);
  });
});
