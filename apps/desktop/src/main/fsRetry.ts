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
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= MAX_RETRIES || !isTransient(err)) throw err;
      sleepSync(RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

/**
 * `rm -rf` that tolerates absence and retries a busy directory. Delegates to Node's built-in
 * retry rather than reimplementing it — `force` covers ENOENT, `maxRetries`/`retryDelay` cover
 * the Windows cases above.
 */
export function rmrfSyncWithRetry(target: string): void {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: MAX_RETRIES, retryDelay: RETRY_DELAY_MS });
}
