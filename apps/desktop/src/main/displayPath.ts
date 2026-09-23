// Home-relative display shortening, shared by the two surfaces that show a path to the user:
// the agent config panel (providers/agentConfigView.ts) and the Skills store (services.ts).
//
// It exists as one function because it was previously written twice, and both copies carried the
// same Windows bug: containment was tested with `abs.startsWith(`${home}/`)`, a hand-built POSIX
// separator. On Windows a home of `C:\Users\Bob` never matches a `C:\Users\Bob/` prefix, so both
// callers returned the full absolute path and shipped the account name across IPC to the
// renderer — for every agent config file and every skills directory. See
// docs/dev-rules/engineering-conventions.md §3 ("use `path` APIs, never hand-built separators").
//
// Display only. The result is never fed back into a filesystem call: the renderer refers to a
// file by (agentId, role) or by a skill name, never by a path it was shown.

import path from 'node:path';

/**
 * The slice of `node:path` this module needs. Taking it as a parameter is what lets a test on
 * any host assert the WINDOWS behaviour by passing `path.win32` — the bug above survived because
 * nothing could express "what does this do with a backslash home?" while running on macOS or a
 * Linux CI runner. Mirrors how app-shortcuts takes `platform` as an injected value rather than
 * reading `process.platform` ambiently.
 */
export type PathFlavour = Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'>;

/**
 * `abs` rewritten as `~/…` when it sits inside `home`, else returned unchanged.
 *
 * Containment is decided by `relative`, which is separator- and drive-aware, rather than by a
 * prefix compare. An absolute result means a different drive (Windows), and a leading `..`
 * segment means the path escaped home; both are shown as-is rather than mislabelled `~`.
 *
 * The output is forward-slashed on every platform on purpose — it is a display string, and the
 * `~` idiom it extends reads as POSIX even on Windows.
 */
export function homeRelativeDisplayPath(
  abs: string,
  home: string,
  flavour: PathFlavour = path,
): string {
  const rel = flavour.relative(home, abs);
  if (rel === '') return '~';
  if (flavour.isAbsolute(rel)) return abs;
  // Segment-wise, not `startsWith('..')`: a file legitimately named `..foo` is inside home.
  const segments = rel.split(flavour.sep);
  if (segments[0] === '..') return abs;
  return `~/${segments.join('/')}`;
}
