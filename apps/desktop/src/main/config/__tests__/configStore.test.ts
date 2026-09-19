import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createConfigStore,
  createFilePreferencePersistence,
  type PreferencePersistence,
} from '../configStore';
import { decodeIpcError, isIpcError } from '../../../shared/ipc-errors';

/** An in-memory persistence adapter so the store logic tests without a filesystem. */
function memoryPersistence(seed: Record<string, unknown> = {}): PreferencePersistence & {
  readonly saved: Record<string, unknown>;
} {
  let store: Record<string, unknown> = { ...seed };
  return {
    load: () => ({ ...store }),
    save: (overrides) => {
      store = { ...overrides };
    },
    get saved() {
      return store;
    },
  };
}

/** The IPC error code from a thrown store error (validators throw coded errors). */
function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (isIpcError(err)) return err.code;
    if (err instanceof Error) return decodeIpcError(err.message).code;
  }
  throw new Error('expected the call to throw a coded error');
}

describe('config store (layered defaults + overrides)', () => {
  it('reads the default when no override is set', () => {
    const store = createConfigStore(memoryPersistence());
    expect(store.get('theme')).toBe('system');
    expect(store.getEffective()).toEqual({ theme: 'system', skillsLibrary: 'app' });
    expect(store.getOverrides()).toEqual({});
  });

  it('set → get round-trips and persists only the override', () => {
    const persistence = memoryPersistence();
    const store = createConfigStore(persistence);
    const next = store.set('theme', 'dark');
    expect(next).toEqual({ theme: 'dark', skillsLibrary: 'app' });
    expect(store.get('theme')).toBe('dark');
    expect(persistence.saved).toEqual({ theme: 'dark' });
  });

  it('reset restores the default by DELETING the override (not snapshotting it)', () => {
    const persistence = memoryPersistence({ theme: 'light' });
    const store = createConfigStore(persistence);
    expect(store.get('theme')).toBe('light');
    const next = store.reset('theme');
    expect(next).toEqual({ theme: 'system', skillsLibrary: 'app' });
    // The override key is gone from the persisted blob — not persisted as 'system'.
    expect(persistence.saved).toEqual({});
    expect(store.getOverrides()).toEqual({});
  });

  it('rejects an invalid value with INVALID_PARAMS and does not persist it', () => {
    const persistence = memoryPersistence();
    const store = createConfigStore(persistence);
    expect(codeOf(() => store.set('theme', 'chartreuse'))).toBe('INVALID_PARAMS');
    expect(store.get('theme')).toBe('system');
    expect(persistence.saved).toEqual({});
  });

  it('rejects an unknown key with INVALID_PARAMS', () => {
    const store = createConfigStore(memoryPersistence());
    // Cast through unknown: the runtime guard, not the type, is what protects us.
    expect(codeOf(() => store.set('nope' as never, 'x'))).toBe('INVALID_PARAMS');
    expect(codeOf(() => store.reset('nope' as never))).toBe('INVALID_PARAMS');
  });

  it('drops an invalid persisted value on load and falls back to the default', () => {
    // A corrupted file that survived some earlier version: theme is nonsense.
    const store = createConfigStore(memoryPersistence({ theme: 42, stale: 'ignored' }));
    expect(store.get('theme')).toBe('system');
    expect(store.getOverrides()).toEqual({});
  });

  it('keeps a valid persisted override on load', () => {
    const store = createConfigStore(memoryPersistence({ theme: 'dark' }));
    expect(store.get('theme')).toBe('dark');
    expect(store.getOverrides()).toEqual({ theme: 'dark' });
  });
});

describe('file preference persistence', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-prefs-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips overrides through a real file', () => {
    const file = path.join(dir, 'preferences.json');
    const store = createConfigStore(createFilePreferencePersistence(file));
    store.set('theme', 'light');

    // A fresh store reading the same file recovers the override.
    const reopened = createConfigStore(createFilePreferencePersistence(file));
    expect(reopened.get('theme')).toBe('light');
  });

  it('reads a missing file as no overrides', () => {
    const file = path.join(dir, 'does-not-exist.json');
    const store = createConfigStore(createFilePreferencePersistence(file));
    expect(store.getEffective()).toEqual({ theme: 'system', skillsLibrary: 'app' });
  });

  it('reads a corrupt file as no overrides rather than throwing', () => {
    const file = path.join(dir, 'preferences.json');
    fs.writeFileSync(file, '{ this is not json', 'utf8');
    const store = createConfigStore(createFilePreferencePersistence(file));
    expect(store.getEffective()).toEqual({ theme: 'system', skillsLibrary: 'app' });
  });
});

describe('skillsLibrary preference', () => {
  it('defaults to app and round-trips a valid override', () => {
    const store = createConfigStore(memoryPersistence());
    expect(store.get('skillsLibrary')).toBe('app');
    expect(store.set('skillsLibrary', 'home')).toEqual({ theme: 'system', skillsLibrary: 'home' });
    expect(store.get('skillsLibrary')).toBe('home');
  });

  it('rejects an invalid location with INVALID_PARAMS', () => {
    const store = createConfigStore(memoryPersistence());
    expect(codeOf(() => store.set('skillsLibrary', 'elsewhere'))).toBe('INVALID_PARAMS');
    expect(store.get('skillsLibrary')).toBe('app');
  });

  it('drops a corrupt persisted value and falls back to app', () => {
    const store = createConfigStore(memoryPersistence({ skillsLibrary: 99 }));
    expect(store.get('skillsLibrary')).toBe('app');
    expect(store.getOverrides()).toEqual({});
  });
});
