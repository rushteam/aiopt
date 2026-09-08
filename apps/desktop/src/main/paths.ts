// Canonical on-disk locations for app-managed data.
//
// Everything the app persists lives under Electron's `userData` directory —
// never the repo, the cwd, or a git-tracked path. See
// docs/dev-rules/credentials-and-local-storage.md.

import { app } from 'electron';
import path from 'node:path';
import { APP_SHORTCUTS_FILE_NAME } from './app-shortcuts/AppShortcutStore';
import type { SkillsLibraryLocation } from '../shared/skills';

/** Layered-preference overrides (defaults are code, only overrides persist). */
export function preferencesFilePath(): string {
  return path.join(app.getPath('userData'), 'preferences.json');
}

/** Directory holding OS-encrypted `<key>.enc` secret files. */
export function secretsDir(): string {
  return path.join(app.getPath('userData'), 'secrets');
}

/** User overrides of app shortcuts (only the rebinds; defaults stay in code). */
export function appShortcutsFilePath(): string {
  return path.join(app.getPath('userData'), APP_SHORTCUTS_FILE_NAME);
}

/** The global provider pool + per-agent bindings (AiOpt's own data; keys live in the secret store). */
export function providersFilePath(): string {
  return path.join(app.getPath('userData'), 'providers.json');
}

/** Append-only usage-statistics log (counts + identifiers only; no content/keys/tokens). */
export function usageHistoryFilePath(): string {
  return path.join(app.getPath('userData'), 'usage-history.jsonl');
}

/**
 * The central Skills library directory, resolved from the enum preference. `'app'` keeps it
 * inside `userData` (managed with the rest of the app's data); `'home'` places it in an
 * independent `~/.aiopt/skills`. The renderer never supplies this path — main computes it here
 * so a hostile renderer can never redirect skill reads/writes to an arbitrary location.
 */
export function skillsLibraryPath(location: SkillsLibraryLocation): string {
  if (location === 'home') {
    return path.join(app.getPath('home'), '.aiopt', 'skills');
  }
  return path.join(app.getPath('userData'), 'skills');
}
