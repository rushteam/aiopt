import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppShortcutStore, type AppShortcutStoreOptions } from '../AppShortcutStore';
import type { AppShortcutCombo, AppShortcutOverrides } from '../../../shared/appShortcuts';

function mk(code: string, mods: Partial<AppShortcutCombo> = {}): AppShortcutCombo {
  return {
    code,
    meta: Boolean(mods.meta),
    ctrl: Boolean(mods.ctrl),
    alt: Boolean(mods.alt),
    shift: Boolean(mods.shift),
  };
}

describe('AppShortcutStore (darwin)', () => {
  let dir: string;
  let file: string;
  let changes: AppShortcutOverrides[];

  function makeStore(overrides: Partial<AppShortcutStoreOptions> = {}): AppShortcutStore {
    return new AppShortcutStore({
      getFilePath: () => file,
      platform: 'darwin',
      onChanged: (o) => changes.push(o),
      ...overrides,
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-shortcuts-'));
    file = path.join(dir, 'app-shortcuts.v1.json');
    changes = [];
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists ONLY the override diff and notifies onChanged', () => {
    const store = makeStore();
    expect(store.setOverride('toggle-theme', mk('KeyJ', { meta: true }))).toBeNull();
    expect(store.getOverrides()).toEqual({ 'toggle-theme': mk('KeyJ', { meta: true }) });
    expect(changes.at(-1)).toEqual({ 'toggle-theme': mk('KeyJ', { meta: true }) });

    // The file holds only the diff, under a versioned envelope.
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk.overrides).toEqual({ 'toggle-theme': mk('KeyJ', { meta: true }) });
  });

  it('null override disables the shortcut (empty effective combos)', () => {
    const store = makeStore();
    expect(store.setOverride('toggle-theme', null)).toBeNull();
    expect(store.getEffectiveCombos('toggle-theme')).toEqual([]);
  });

  it('reopening a store recovers the persisted overrides', () => {
    makeStore().setOverride('toggle-theme', mk('KeyJ', { meta: true }));
    const reopened = makeStore();
    expect(reopened.getEffectiveCombos('toggle-theme')).toEqual([mk('KeyJ', { meta: true })]);
  });

  it('clearOverride and resetAll delete overrides (back to defaults)', () => {
    const store = makeStore();
    store.setOverride('toggle-theme', mk('KeyJ', { meta: true }));
    store.setOverride('check-for-updates', mk('KeyK', { meta: true }));
    store.clearOverride('toggle-theme');
    expect(store.getOverrides()).toEqual({ 'check-for-updates': mk('KeyK', { meta: true }) });
    // Default restored for the cleared one.
    expect(store.getEffectiveCombos('toggle-theme')).toEqual([mk('KeyL', { meta: true, shift: true })]);
    store.resetAll();
    expect(store.getOverrides()).toEqual({});
  });

  it('rejects invalid rebinds with the right reason and does not persist', () => {
    const store = makeStore();
    expect(store.setOverride('nope', mk('KeyJ', { meta: true }))).toBe('unknown-id');
    expect(store.setOverride('toggle-theme', { garbage: true })).toBe('invalid-combo');
    expect(store.setOverride('toggle-theme', mk('KeyA'))).toBe('not-bindable'); // bare letter
    expect(store.setOverride('toggle-theme', mk('KeyC', { meta: true }))).toBe('system-reserved'); // ⌘C
    // ⌘U is check-for-updates' default → conflict. (⌘, is macOS-reserved, so it
    // trips the system-reserved gate before the conflict check — hence ⌘U here.)
    expect(store.setOverride('toggle-theme', mk('KeyU', { meta: true }))).toBe('conflict');
    // A menu-backed id needs an expressible accelerator on darwin.
    expect(store.setOverride('open-settings', mk('IntlBackslash', { meta: true }))).toBe(
      'menu-inexpressible',
    );
    expect(store.getOverrides()).toEqual({});
    expect(changes).toEqual([]);
  });

  it('self-heals a corrupt file to no overrides', () => {
    fs.writeFileSync(file, '{ not json', 'utf-8');
    expect(makeStore().getOverrides()).toEqual({});
  });
});
