// Layered preference store — the "default + user override" primitive.
//
// The effective value of every preference is `override ?? default`. Persistence
// records ONLY overrides, never a copy of the defaults, so a user who never
// touched a setting rides along with new defaults on upgrade, while a user who
// customized it keeps their choice. "Restore default" deletes the override — it
// does not write a static snapshot of today's default. See
// docs/dev-rules/configuration-and-overrides.md.
//
// The store is Electron-free so it unit-tests without a running app: the file
// persistence adapter below takes a plain path, and tests can inject an
// in-memory adapter instead.

import fs from 'node:fs';
import path from 'node:path';
import type { PreferencesShape, ThemePreference } from '../../shared/ipc-channels';
import type { SkillsLibraryLocation } from '../../shared/skills';
import { throwIpcError } from '../ipc/validate';

interface PreferenceDef<K extends keyof PreferencesShape> {
  default: PreferencesShape[K];
  /** Validate an untrusted value; throw INVALID_PARAMS if it isn't legal for this key. */
  validate(raw: unknown): PreferencesShape[K];
}

const THEME_VALUES: readonly ThemePreference[] = ['system', 'light', 'dark'];
const SKILLS_LIBRARY_VALUES: readonly SkillsLibraryLocation[] = ['app', 'home'];

/** The known preferences: default + runtime validator for each. */
export const PREFERENCES: { [K in keyof PreferencesShape]: PreferenceDef<K> } = {
  theme: {
    default: 'system',
    validate(raw) {
      if (typeof raw !== 'string' || !THEME_VALUES.includes(raw as ThemePreference)) {
        throwIpcError('INVALID_PARAMS', 'theme must be one of: system | light | dark');
      }
      return raw as ThemePreference;
    },
  },
  skillsLibrary: {
    default: 'app',
    validate(raw) {
      if (typeof raw !== 'string' || !SKILLS_LIBRARY_VALUES.includes(raw as SkillsLibraryLocation)) {
        throwIpcError('INVALID_PARAMS', 'skillsLibrary must be one of: app | home');
      }
      return raw as SkillsLibraryLocation;
    },
  },
  proxyMode: {
    // Off by default: same-format bindings connect directly to the provider, so they
    // keep working when AiOpt isn't running (their usage is not counted). On routes
    // every translatable binding through the proxy for usage counting.
    default: false,
    validate(raw) {
      if (typeof raw !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'proxyMode must be a boolean');
      }
      return raw;
    },
  },
};

export const PREFERENCE_KEYS = Object.keys(PREFERENCES) as (keyof PreferencesShape)[];

export function isPreferenceKey(key: unknown): key is keyof PreferencesShape {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(PREFERENCES, key);
}

/** Persistence of the OVERRIDES blob only (never the full default set). */
export interface PreferencePersistence {
  load(): Record<string, unknown>;
  save(overrides: Record<string, unknown>): void;
}

export interface ConfigStore {
  /** Effective value of one key (override ?? default). */
  get<K extends keyof PreferencesShape>(key: K): PreferencesShape[K];
  /** Effective snapshot of every preference. */
  getEffective(): PreferencesShape;
  /** Validate + store an override; returns the effective snapshot after the change. */
  set(key: keyof PreferencesShape, rawValue: unknown): PreferencesShape;
  /** Restore default = delete the override; returns the effective snapshot after. */
  reset(key: keyof PreferencesShape): PreferencesShape;
  /** The overrides only (for inspection / tests) — not merged with defaults. */
  getOverrides(): Partial<PreferencesShape>;
}

export function createConfigStore(persistence: PreferencePersistence): ConfigStore {
  // Overrides kept as a loosely-typed map; typed reads cast at the edges. On load
  // we keep only known keys whose persisted value still validates — a stale key
  // or a corrupted value is dropped so a bad file can never wedge startup.
  const overrides = new Map<keyof PreferencesShape, unknown>();
  const raw = persistence.load();
  for (const key of PREFERENCE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    try {
      overrides.set(key, PREFERENCES[key].validate(raw[key]));
    } catch {
      // Drop the invalid persisted value; the key falls back to its default.
    }
  }

  function get<K extends keyof PreferencesShape>(key: K): PreferencesShape[K] {
    return (overrides.has(key) ? overrides.get(key) : PREFERENCES[key].default) as PreferencesShape[K];
  }

  function getEffective(): PreferencesShape {
    const out: Record<string, unknown> = {};
    for (const key of PREFERENCE_KEYS) out[key] = get(key);
    return out as unknown as PreferencesShape;
  }

  function persist(): void {
    persistence.save(Object.fromEntries(overrides));
  }

  return {
    get,
    getEffective,
    set(key, rawValue) {
      if (!isPreferenceKey(key)) throwIpcError('INVALID_PARAMS', 'unknown preference key');
      overrides.set(key, PREFERENCES[key].validate(rawValue));
      persist();
      return getEffective();
    },
    reset(key) {
      if (!isPreferenceKey(key)) throwIpcError('INVALID_PARAMS', 'unknown preference key');
      overrides.delete(key);
      persist();
      return getEffective();
    },
    getOverrides() {
      return Object.fromEntries(overrides) as Partial<PreferencesShape>;
    },
  };
}

/**
 * File-backed persistence for the overrides blob. Node-only (no Electron), so it
 * is testable against a tmp dir; production points it at
 * `userData/preferences.json` (see main/paths.ts). A missing or corrupt file
 * reads as "no overrides" rather than throwing.
 */
export function createFilePreferencePersistence(filePath: string): PreferencePersistence {
  return {
    load() {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Missing or unparseable → no overrides.
      }
      return {};
    },
    save(overrides) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
    },
  };
}
