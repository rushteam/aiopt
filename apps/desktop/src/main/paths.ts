// Canonical on-disk locations for app-managed data.
//
// App config, secrets, and logs live under Electron's `userData` directory —
// never the repo, the cwd, or a git-tracked path. The skills library is the
// exception: the user can point it at `~/.aiopt/skills` or `~/.agents/skills`
// (still derived from `app.getPath('home')`, never a checkout). See
// docs/dev-rules/credentials-and-local-storage.md.

import { app } from 'electron';
import path from 'node:path';
import { APP_SHORTCUTS_FILE_NAME } from './app-shortcuts/AppShortcutStore';
import type { SkillsLibraryLocation } from '../shared/skills';
import { skillsLibraryDir } from './skills/skillsLibraryDir';

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
 * The translation proxy's persisted identity: the fixed loopback port and the per-binding
 * path tokens, so a restart reuses the same `http://127.0.0.1:<port>/<token>` an agent already
 * cached instead of minting a fresh one it would then 401 against. Tokens are class-secret but
 * NOT the real provider key (that stays in the secret store); they are already written in
 * plaintext into each agent's own config, so persisting them here does not widen exposure. See
 * docs/dev-rules/credentials-and-local-storage.md.
 */
export function proxyStateFilePath(): string {
  return path.join(app.getPath('userData'), 'proxy.json');
}

/**
 * The central Skills library directory, resolved from the enum preference.
 * `'app'` keeps it inside `userData` (managed with the rest of the app's data);
 * `'home'` places it in an independent `~/.aiopt/skills`; `'agents'` places it in
 * `~/.agents/skills`, the cross-client user skills directory. All three are derived
 * from `app.getPath` — never a project path, so skill files are not written into a
 * git checkout. The renderer never supplies this path — main computes it here so a
 * hostile renderer can never redirect skill reads/writes to an arbitrary location.
 */
export function skillsLibraryPath(location: SkillsLibraryLocation): string {
  return skillsLibraryDir(location, {
    userData: app.getPath('userData'),
    home: app.getPath('home'),
  });
}

/**
 * The workbench's own data: its private pi config dir (models.json references the credential
 * as `$AIOPT_WB_KEY` and never holds it), the orchestrator's read-only extension and empty cwd,
 * and the granted-folders list. Never the user's `~/.pi/agent`.
 */
export function workbenchDir(): string {
  return path.join(app.getPath('userData'), 'workbench');
}
