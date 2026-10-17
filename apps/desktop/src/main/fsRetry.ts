// Retrying wrappers for the two filesystem operations that fail transiently on Windows.
//
// Every store in this app commits a write as temp-file + rename, and the skills sync replaces
// whole directories the same way. On POSIX those calls fail only for real reasons. On Windows
// they also fail because someone else has the file open: an agent CLI holding its own
// `settings.json`, Defender mid-scan, a backup agent, an Explorer window parked in a skill
// directory. `MoveFileExW` reports that as EPERM/EACCES/EBUSY, and `RemoveDirectory` as
// EBUSY/ENOTEMPTY/EPERM — all of which clear on their own within milliseconds.
//
// Without a retry the user sees a bind or a skills push fail with an opaque error and succeed on
// the second click. Node already solves the directory half (`fs.rmSync`'s `maxRetries`), so this
// module supplies the same treatment for `rename` and a named constant both can share.
//
// NOT a fix for a genuine permission problem: the last failure is rethrown unchanged, so a real
// EACCES still surfaces — it just surfaces a few tens of milliseconds later.

import fs from 'node:fs';
import path from 'node:path';

/**
 * How many times to retry, and the base delay. Node's own `rmSync` retry ramps the delay
 * linearly; we do the same, so the worst case here is 10+20+30 = 60ms of added latency on a
 * path that already failed. Small enough to keep in front of a click, long enough to outlast an
 * antivirus handle.
 */
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10;

/** Error codes that mean "someone else has it open, try again", as opposed to a real refusal. */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

/**
 * Block the calling thread for `ms`. Synchronous on purpose: every caller is a synchronous
 * store commit, and making them async would change the shape of code whose atomicity is the
 * point. `Atomics.wait` is the only precise sync sleep available; `fs.rmSync`'s own retry
 * blocks the same way.
 */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function isTransient(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && TRANSIENT_CODES.has(code);
}

/**
 * `fs.renameSync` that retries a transient Windows failure. Replacing an existing destination is
 * NOT the problem this solves — libuv maps rename onto `MoveFileExW` with
 * `MOVEFILE_REPLACE_EXISTING`, so overwriting works on Windows. The problem is a destination (or
 * source) another process holds open without `FILE_SHARE_DELETE`.
 *
 * A non-transient error (ENOENT, ENOSPC, a genuine EACCES that does not clear) is rethrown
 * immediately without burning the retry budget.
 */
export function renameSyncWithRetry(from: string, to: string): void {
  retrySync(() => fs.renameSync(from, to));
}

/** Run `op`, retrying a transient Windows failure with the linear ramp above. */
function retrySync(op: () => void): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      op();
      return;
    } catch (err) {
      if (attempt >= MAX_RETRIES || !isTransient(err)) throw err;
      sleepSync(RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/**
 * `rm -rf` that tolerates absence, retries a busy entry, and NEVER follows a link.
 *
 * A recursive `fs.rmSync` is not trusted here: on Windows it has followed directory junctions
 * and deleted the TARGET's contents. The trees this removes are agent skill directories, where
 * a user linking a skill to their own working copy is ordinary — following that link would
 * delete the user's real files. So the walk uses only leaf operations: a symlink / junction
 * (`lstat` reports both as a link) is unlinked itself, a file is removed, and a directory is
 * emptied the same way and then `rmdir`ed.
 */
export function rmrfSyncWithRetry(target: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    if (isMissing(err)) return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    retrySync(() => {
      try {
        fs.unlinkSync(target);
      } catch (err) {
        if (isMissing(err)) return;
        // A directory link / junction on Windows refuses unlink (EPERM); rmdir removes the
        // link itself, never its target's contents.
        if (process.platform !== 'win32') throw err;
        fs.rmdirSync(target);
      }
    });
    return;
  }
  if (!st.isDirectory()) {
    retrySync(() => fs.rmSync(target, { force: true }));
    return;
  }
  for (const name of fs.readdirSync(target)) rmrfSyncWithRetry(path.join(target, name));
  retrySync(() => {
    try {
      fs.rmdirSync(target);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  });
}
