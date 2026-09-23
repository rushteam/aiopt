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
import { renameSyncWithRetry } from '../fsRetry';
import { logger, maskPath } from '../logger';
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
 *
 * `mode` IS NOT HONOURED ON WINDOWS. Node maps `chmod` onto the FAT-era read-only attribute
 * only, and 0o600 has the write bit set, so the call is a complete no-op and the file inherits
 * its parent directory's ACL; `mkdir`'s `mode` is ignored outright. Rather than let the
 * guarantee fail silently, {@link verifyMode} checks the result and logs `config.mode_unenforced`
 * when the bits did not stick — the write still proceeds, because refusing to write would break
 * the binding on every Windows machine, and the ACL under `%USERPROFILE%` is not world-readable
 * by default.
 * Callers that need real confidentiality must use the OS secret store, not a file mode; this
 * path exists only because an external CLI dictates the on-disk format.
 */
export function atomicWriteFile(target: string, contents: string, mode?: number): void {
  const tmp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), mode === undefined ? { recursive: true } : { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tmp, contents, mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode });
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    renameSyncWithRetry(tmp, target);
  } catch (err) {
    discardTemp(tmp, mode !== undefined);
    throw err;
  }
  // After the try: the file is committed, and a verification failure must not run the
  // temp-cleanup path or mask a successful write.
  if (mode !== undefined) verifyMode(target, mode);
}

/**
 * Remove the temp file after a failed write. `heldSecret` marks a temp that contained a
 * credential (the only moded caller is dsh's `.credentials.yaml`, which holds a plaintext
 * provider key): before unlinking, its contents are overwritten so a failure of the unlink
 * itself cannot leave the key readable on disk.
 *
 * That failure is a real Windows scenario, not a theoretical one — the same file locking that
 * makes the rename fail can make the unlink fail too, and `<file>.tmp` is outside the write
 * allowlist, so `restoreAgentConfigFile` (which only ever touches `<target>` and
 * `<target>.aiopt.bak`) would never clean it up. "Restore defaults" would leave the key behind
 * forever. Truncating first means the worst case is an empty stray file.
 *
 * Every step is best-effort and swallows its own error: the caller is about to rethrow the
 * original write failure, which is the one worth reporting.
 */
function discardTemp(tmp: string, heldSecret: boolean): void {
  if (heldSecret) {
    try {
      // Overwrite in place, then truncate — not a secure multi-pass erase (impossible to
      // promise on a journalling or copy-on-write filesystem, or on an SSD), just enough that
      // a surviving file does not still spell out the key.
      const size = fs.statSync(tmp).size;
      if (size > 0) fs.writeFileSync(tmp, '\0'.repeat(size));
      fs.truncateSync(tmp, 0);
    } catch {
      // Nothing to scrub, or it is already unreachable; fall through to the unlink.
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    // Best-effort cleanup; preserve the original write error.
  }
}

/**
 * Warn when the filesystem did not actually apply `expected`. Verification, not enforcement: it
 * runs after the rename and never throws, so a platform that cannot honour a mode still gets a
 * working config file — it just says so in the log instead of pretending. A stat failure is
 * ignored for the same reason (the write itself already succeeded).
 *
 * Logged fields are non-identifying: `maskPath` keeps only the basename, and the modes are
 * octal permission bits, not content. See engineering-conventions.md §1.
 */
function verifyMode(target: string, expected: number): void {
  let actual: number;
  try {
    actual = fs.statSync(target).mode & 0o777;
  } catch {
    return;
  }
  if (actual === expected) return;
  logger.warn('config.mode_unenforced', {
    file: maskPath(target),
    expected: expected.toString(8),
    actual: actual.toString(8),
    platform: process.platform,
  });
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
    //
    // POSIX only. On Windows `statSync().mode` reports a synthesised 0o666 regardless of the
    // real ACL, so what is read here and passed back through `atomicWriteFile` is a fiction on
    // both ends; `verifyMode` logs `config.mode_unenforced` when that happens. Restoring does
    // not WIDEN access there — the file inherits the `%USERPROFILE%` ACL, which is already
    // owner-only — it simply cannot narrow it either. See credentials-and-local-storage.md:
    // confidentiality for real secrets rests on `safeStorage`, never on these bits.
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
 *
 * A leading BOM is stripped before parsing, because `JSON.parse` THROWS on U+FEFF and would
 * otherwise take the fail-open path on a perfectly valid file. That mattered most on Windows,
 * where a BOM is a routine artifact — PowerShell 5.1's `>`, `Out-File` and `Set-Content` all
 * write one, as do older editors. Every caller here merges INTO the object this returns, so a
 * spurious `{}` silently replaced the user's config with only AiOpt's keys: Claude's other
 * settings, the ChatGPT OAuth `tokens` block codexAdapter exists to preserve, OpenCode's other
 * providers and `mcp`/`plugin` sections. Recoverable from `<file>.aiopt.bak`, but the live file
 * was already clobbered with nothing said. `skillsFs.parseSkillFrontmatter` strips a BOM for the
 * same reason.
 */
export function readJsonObject(target: string): Record<string, unknown> {
  try {
    const text = fs.readFileSync(target, 'utf-8').replace(/^\uFEFF/, '');
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unparseable → start from an empty object.
  }
  return {};
}
