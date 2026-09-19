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

/**
 * Atomic write: mkdir -p, write a temp file, then rename over the target. When `mode`
 * is given (e.g. 0o600 for a secret file some agents refuse to load if group/other-
 * readable), it is applied to the containing dir (0o700) and to the file itself —
 * chmod'd explicitly after write so a pre-existing temp file's looser mode can't leak.
 */
export function atomicWriteFile(target: string, contents: string, mode?: number): void {
  const tmp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), mode === undefined ? { recursive: true } : { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tmp, contents, mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode });
    if (mode !== undefined) fs.chmodSync(tmp, mode);
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

/**
 * allowlist → backup → atomic write. The single entry point adapters use. Pass `mode`
 * (e.g. 0o600) for a secret file that must stay owner-only on disk.
 */
export function writeAgentConfigFile(target: string, contents: string, mode?: number): void {
  assertAgentConfigPath(target);
  backupOnce(target);
  atomicWriteFile(target, contents, mode);
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
    // Preserve the original's permission bits (backupOnce's copyFileSync kept them), so
    // restoring an owner-only secret file hands it back at 0600 rather than the umask.
    const originalMode = fs.statSync(backup).mode & 0o777;
    atomicWriteFile(target, fs.readFileSync(backup, 'utf-8'), originalMode);
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
