// Canonical on-disk locations for app-managed data.
//
// Everything the app persists lives under Electron's `userData` directory —
// never the repo, the cwd, or a git-tracked path. See
// docs/dev-rules/credentials-and-local-storage.md.

import { app } from 'electron';
import path from 'node:path';
import { APP_SHORTCUTS_FILE_NAME } from './app-shortcuts/AppShortcutStore';

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
