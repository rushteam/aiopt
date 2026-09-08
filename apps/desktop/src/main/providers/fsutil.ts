// Filesystem helpers for rewriting agent config files — the risky part of AiOpt.
//
// Every write to an agent's native config goes through `writeAgentConfigFile`,
// which enforces three protections in order (see the plan's security review):
//   1. allowlist   — refuse any path that isn't a known agent config file;
//   2. backup-once — keep the user's pristine original as `<file>.aiopt.bak`;
//   3. atomic      — temp-file + rename, so a crash mid-write never truncates.
//
// `atomicWriteFile` mirrors AppShortcutStore.save()'s temp+rename shape.

import fs from 'node:fs';
import path from 'node:path';
import { throwIpcError } from '../ipc/validate';
import { isAllowedAgentConfigPath } from './agentPaths';

/** Suffix for the one-time pristine backup taken before AiOpt first rewrites a file. */
export const AGENT_BACKUP_SUFFIX = '.aiopt.bak';

/** Throw PERMISSION_DENIED unless `target` is an allowlisted agent config path. */
export function assertAgentConfigPath(target: string): void {
  if (!isAllowedAgentConfigPath(target)) {
    throwIpcError('PERMISSION_DENIED', 'refusing to write outside the agent config allowlist');
  }
}

/**
 * Copy `target` to `<target>.aiopt.bak` the FIRST time only, preserving the user's
 * pristine pre-AiOpt config. A missing source (first-ever write) is a no-op; an
 * existing backup is left untouched so it always holds the earliest state.
 */
export function backupOnce(target: string): void {
  const backup = `${target}${AGENT_BACKUP_SUFFIX}`;
  if (fs.existsSync(backup)) return;
  try {
    fs.copyFileSync(target, backup);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // No original to back up yet — nothing to preserve.
  }
}

/** Atomic write: mkdir -p, write a temp file, then rename over the target. */
export function atomicWriteFile(target: string, contents: string): void {
  const tmp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(tmp, contents, 'utf-8');
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup; preserve the original write error.
    }
    throw err;
  }
}

/** allowlist → backup → atomic write. The single entry point adapters use. */
export function writeAgentConfigFile(target: string, contents: string): void {
  assertAgentConfigPath(target);
  backupOnce(target);
  atomicWriteFile(target, contents);
}

/**
 * Reverse a takeover: restore one agent config file to its pre-AiOpt state. The
 * faithful inverse of `writeAgentConfigFile`, driven entirely by the backup:
 *   - `<file>.aiopt.bak` exists  → the user had an original; write it back
 *     (atomic) and delete the backup, handing the file back to the user.
 *   - no backup but `<file>` exists → AiOpt created it from nothing (first write
 *     found no original to back up), so removing it returns to "no file".
 *   - neither exists → nothing to undo (no-op).
 * Allowlisted like every write; it never touches a path outside the allowlist.
 */
export function restoreAgentConfigFile(target: string): void {
  assertAgentConfigPath(target);
  const backup = `${target}${AGENT_BACKUP_SUFFIX}`;
  if (fs.existsSync(backup)) {
    atomicWriteFile(target, fs.readFileSync(backup, 'utf-8'));
    fs.rmSync(backup, { force: true });
    return;
  }
  // No backup → either AiOpt created the file, or we never touched it. Remove the
  // file if present (faithful inverse of a create); otherwise there is nothing to do.
  fs.rmSync(target, { force: true });
}

/**
 * Read a JSON object from disk for a merge, returning `{}` for a missing OR corrupt
 * file. Fail-open is intentional here: a rewrite should proceed and repair rather
 * than wedge on a hand-edited file, and we still back up the original first.
 */
export function readJsonObject(target: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unparseable → start from an empty object.
  }
  return {};
}
