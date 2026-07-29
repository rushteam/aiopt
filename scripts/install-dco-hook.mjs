#!/usr/bin/env node
// Local DCO sign-off hook installer: copies this repo's .githooks/prepare-commit-msg into
// the current repo's hooks directory, so that every later `git commit` (including automated
// agent commits) appends a Signed-off-by trailer — signing the commit's committer, exactly
// like native `git commit -s`. This avoids rework when a PR is blocked by the DCO check (the
// DCO GitHub App, configured in .github/dco.yml); the local pre-commit self-check is
// scripts/check-dco.mjs, and the authority on a PR is the App's check.
//
// Usage:
//   pnpm dco:install-hook                      install the hook (refuses if present and edited, see below)
//   node scripts/install-dco-hook.mjs --check  report status only, write nothing
//   node scripts/install-dco-hook.mjs --force  overwrite a hook that came from this repo but was edited
//
// The hook's source of truth is .githooks/prepare-commit-msg (a plain shell script, directly
// reviewable and shellcheck-able); this installer only copies it and decides whether it can
// safely overwrite — it does not generate the script's content. A developer who wants to skip
// the installer can `git config core.hooksPath .githooks` — but that takes over the entire
// hooks directory, so the default is to copy, coexisting with a developer's other hooks.
//
// The hook is a purely local convenience: it does not touch the remote or core.hooksPath;
// deleting the installed file uninstalls it.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Identifies "this hook was installed by this repo", to decide whether it can be overwritten. Matches the comment in the hook source. */
export const HOOK_MARKER = 'hearth-dco-signoff-hook';
export const HOOK_NAME = 'prepare-commit-msg';
export const HOOK_SOURCE_PATH = join('.githooks', HOOK_NAME);

/** Single source of truth for the hook content. */
export function readHookSource() {
  return readFileSync(join(REPO_ROOT, HOOK_SOURCE_PATH), 'utf8');
}

/**
 * Turn `git rev-parse --git-path hooks` into an absolute path.
 *
 * Key point: the relative path it returns is relative to the **cwd git was run from**, not
 * the repo root. Called from a subdirectory it returns something like `../../.git/hooks`, and
 * resolving that against the repo root would climb too far up, writing the hook into a sibling
 * or parent repo's .git/hooks — so the base must be the same cwd. Extracted so this can be
 * asserted directly: reaching this branch needs git < 2.31, which CI cannot hit.
 */
export function resolveHooksPathFrom(hooksPath, cwd) {
  return isAbsolute(hooksPath) ? hooksPath : resolve(cwd, hooksPath);
}

/**
 * Hooks directory: via `git rev-parse --git-path hooks`, so it automatically respects any
 * configured core.hooksPath; multiple worktrees share a common dir, so installing once covers
 * every worktree. --path-format needs git 2.31+; older versions fall back to
 * resolveHooksPathFrom.
 */
export function resolveHooksDir(cwd = process.cwd()) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    return git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  } catch {
    // --path-format needs git 2.31+; older versions land here.
    return resolveHooksPathFrom(git(['rev-parse', '--git-path', 'hooks']), cwd);
  }
}

/**
 * Returns `missing` (none) / `installed` (content byte-identical to the source) / `modified`
 * (recognizably from this repo, but content now differs) / `foreign` (not this repo's at all).
 *
 * Only `installed` and `missing` may be written unconditionally. We deliberately do not try to
 * distinguish "an older version this repo installed" from "installed then edited afterwards" —
 * on disk they are indistinguishable: whether someone merged this repo's logic into their own
 * hook or appended a few lines after ours, the result is "looks like this repo's, but not
 * equal to the source". Any attempt to claim them by leading lines or marker position would
 * misjudge some combination and overwrite the whole file, erasing the developer's logic. So
 * overwriting always requires an explicit --force.
 */
export function classifyHook(existingContent, expectedContent) {
  // Judge missing before reading the source: default params evaluate at call time, so
  // `classifyHook(null)` would still touch disk and tie "no hook" to the source being readable.
  if (existingContent === null) return 'missing';
  const expected = expectedContent ?? readHookSource();
  if (existingContent === expected) return 'installed';
  return existingContent.includes(HOOK_MARKER) ? 'modified' : 'foreign';
}

export function readHook(hookPath) {
  try {
    return readFileSync(hookPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Git only runs hooks with the owner execute bit; without it the content does not matter. */
export function isExecutable(hookPath) {
  try {
    return (statSync(hookPath).mode & 0o100) !== 0;
  } catch {
    return false;
  }
}

/** For check-dco.mjs to decide whether to suggest installing after a local pass. Any probe failure is treated as "installed" so it never nags. */
export function isSignOffHookInstalled(cwd = process.cwd()) {
  try {
    const hookPath = join(resolveHooksDir(cwd), HOOK_NAME);
    return classifyHook(readHook(hookPath)) !== 'missing';
  } catch {
    return true;
  }
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const force = process.argv.includes('--force');
  const hooksDir = resolveHooksDir();
  const hookPath = join(hooksDir, HOOK_NAME);
  const source = readHookSource();
  const state = classifyHook(readHook(hookPath), source);

  // --check reports only; it does not write and does not fail on state: the caller wants
  // facts, not a gate.
  if (checkOnly) {
    const executableNote =
      state === 'installed' && !isExecutable(hookPath) ? ', but NOT executable — Git will ignore it' : '';
    const label = {
      installed: `installed, matching ${HOOK_SOURCE_PATH}${executableNote}`,
      modified: "present but differs from this repo's version (older, or edited locally)",
      missing: 'not installed',
      foreign: 'a different prepare-commit-msg hook is present; not taken over',
    }[state];
    console.log(`DCO sign-off hook: ${label} (${hookPath})`);
    return;
  }

  if (state === 'installed') {
    // Content matches but the execute bit was lost (manual copy, backup restore, chmod 0644):
    // git silently ignores the hook and commits go unsigned — while an installer that only
    // checked content would report "already up to date" and mislead.
    if (!isExecutable(hookPath)) {
      chmodSync(hookPath, 0o755);
      console.log(`Restored the executable bit on ${hookPath}`);
      console.log('(Git silently ignores hooks that are not executable, so commits were unsigned.)');
      return;
    }
    console.log(`DCO sign-off hook already up to date: ${hookPath}`);
    return;
  }

  if (state === 'foreign') {
    console.error(`A ${HOOK_NAME} hook not managed by this repository already exists:`);
    console.error(`  ${hookPath}`);
    console.error(`Leaving it untouched. Either merge the logic from ${HOOK_SOURCE_PATH} into it`);
    console.error('— this installer will then keep its hands off that file, so you own keeping the');
    console.error('merged copy in sync — or use `git config core.hooksPath .githooks` instead.');
    process.exit(1);
  }

  // modified: possibly an older version this repo installed, possibly something you edited
  // afterwards. On disk they cannot be told apart, so we do not guess — an explicit --force is
  // required, because guessing wrong deletes someone's hook logic.
  if (state === 'modified' && !force) {
    console.error(`${hookPath} came from this repository but no longer matches ${HOOK_SOURCE_PATH}.`);
    console.error('It is either an older version of the hook, or a copy you have edited since.');
    console.error('Not overwriting it. Compare first, then decide:');
    // git diff rather than diff(1): git is already a prerequisite of this repo, while diff is
    // absent in some Windows environments.
    console.error(`  git diff --no-index ${hookPath} ${join(REPO_ROOT, HOOK_SOURCE_PATH)}`);
    console.error('  node scripts/install-dco-hook.mjs --force   # overwrite with this repo\'s version');
    process.exit(1);
  }

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, source, 'utf8');
  chmodSync(hookPath, 0o755);
  console.log(`${state === 'modified' ? 'Overwrote' : 'Installed'} DCO sign-off hook: ${hookPath}`);
  console.log(
    `Copied from ${HOOK_SOURCE_PATH}. git commit will now append Signed-off-by; ` +
      'delete the installed file to uninstall.'
  );
}

// Run only when invoked as an entry point; when imported, export pure and probe functions.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}
