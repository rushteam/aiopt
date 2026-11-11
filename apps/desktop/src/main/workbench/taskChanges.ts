// Read-only view of what a task changed: `git diff` of its checkout against the commit the
// task started from, plus untracked files. Main resolves the directory from its own task
// record; the renderer only names the task.
//
// Every git call is hardened against running anything but git itself: no external diff or
// textconv driver, no fsmonitor hook, no pager, no optional index writes. Output is capped
// (file count, per-patch and total characters) before it crosses IPC.

import {
  WORKBENCH_LIMITS,
  type TaskChangedFile,
  type TaskChanges,
  type TaskChangeStatus,
} from '../../shared/workbench';

export interface GitExecResult {
  code: number | null;
  stdout: string;
}

/** execFile of git (no shell); resolves on a non-zero exit, rejects on a spawn failure / overflow. */
export type GitExec = (args: readonly string[]) => Promise<GitExecResult>;

const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function isCommitId(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_RE.test(value);
}

/** `-c` overrides placed before every subcommand. */
export const GIT_SAFE_CONFIG: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=false',
  '-c',
  'color.ui=false',
];

/** Extra environment for those git calls (merged over the CLI allowlist env). */
export const GIT_SAFE_ENV: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
};

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames'] as const;

function git(dir: string, args: readonly string[]): string[] {
  return [...GIT_SAFE_CONFIG, '-C', dir, ...args];
}

/** The checkout's HEAD commit, or null (not a repo, no commits yet, git failed). */
export async function readHeadCommit(exec: GitExec, dir: string): Promise<string | null> {
  try {
    const out = await exec(git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']));
    const id = out.stdout.trim();
    return out.code === 0 && isCommitId(id) ? id : null;
  } catch {
    return null;
  }
}

interface StatEntry {
  path: string;
  oldPath: string | null;
  additions: number | null;
  deletions: number | null;
}

/** `git diff --numstat -z`: `a\td\tpath\0`, or `a\td\t\0old\0new\0` for a rename. */
export function parseNumstatZ(text: string): StatEntry[] {
  const parts = text.split('\0');
  const out: StatEntry[] = [];
  let i = 0;
  while (i < parts.length) {
    const head = parts[i++] ?? '';
    if (head === '') continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m || m[3] === undefined) continue;
    const additions = m[1] === '-' ? null : Number(m[1]);
    const deletions = m[2] === '-' ? null : Number(m[2]);
    if (m[3] !== '') {
      out.push({ path: m[3], oldPath: null, additions, deletions });
      continue;
    }
    const oldPath = parts[i++];
    const path = parts[i++];
    if (!oldPath || !path) break;
    out.push({ path, oldPath, additions, deletions });
  }
  return out;
}

/** `git diff --name-status -z`: status letter per new path. */
export function parseNameStatusZ(text: string): Map<string, TaskChangeStatus> {
  const parts = text.split('\0');
  const out = new Map<string, TaskChangeStatus>();
  let i = 0;
  while (i < parts.length) {
    const code = parts[i++] ?? '';
    if (code === '') continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      i++; // old path
      const path = parts[i++];
      if (!path) break;
      out.set(path, letter === 'R' ? 'renamed' : 'added');
      continue;
    }
    const path = parts[i++];
    if (!path) break;
    out.set(path, letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified');
  }
  return out;
}

/** Split a multi-file unified diff into one chunk per `diff --git` header. */
export function splitPatch(text: string): string[] {
  const chunks: string[] = [];
  let start = -1;
  let at = 0;
  while (at <= text.length) {
    const next = text.indexOf('diff --git ', at);
    if (next === -1) break;
    if (next === 0 || text[next - 1] === '\n') {
      if (start !== -1) chunks.push(text.slice(start, next));
      start = next;
    }
    at = next + 1;
  }
  if (start !== -1) chunks.push(text.slice(start));
  return chunks;
}

/** The new path a chunk's `diff --git a/<old> b/<new>` header ends with matches `path`. */
function chunkIsFor(chunk: string, path: string): boolean {
  const eol = chunk.indexOf('\n');
  const header = eol === -1 ? chunk : chunk.slice(0, eol);
  return header.endsWith(` b/${path}`) || header.endsWith(` "b/${path}"`);
}

function countLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    else if (!inHunk) continue;
    else if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

function isBinaryPatch(patch: string): boolean {
  return /^Binary files .* differ$/m.test(patch) || patch.includes('\nGIT binary patch\n');
}

/**
 * Read what changed in `dir` since `base` (a commit id, or null for HEAD). Paths are relative
 * to `dir` (`--relative`), so an in-place task in a repo subfolder sees only its folder.
 */
export async function readTaskChanges(exec: GitExec, dir: string, base: string | null): Promise<TaskChanges> {
  const L = WORKBENCH_LIMITS;
  let since: TaskChanges['since'] = 'head';
  let rev: string | null = null;
  if (base && isCommitId(base)) {
    const ok = await exec(git(dir, ['cat-file', '-e', `${base}^{commit}`])).catch(() => null);
    if (ok && ok.code === 0) {
      rev = base;
      since = 'launch';
    }
  }
  if (!rev) rev = await readHeadCommit(exec, dir);

  let truncated = false;
  const files: TaskChangedFile[] = [];
  let budget = L.changesChars;

  if (rev) {
    const range = [rev, '--'];
    const [numstat, names] = await Promise.all([
      exec(git(dir, ['diff', ...DIFF_FLAGS, '--relative', '--numstat', '-z', ...range])),
      exec(git(dir, ['diff', ...DIFF_FLAGS, '--relative', '--name-status', '-z', ...range])),
    ]);
    if (numstat.code !== 0 || names.code !== 0) throw new Error('git diff failed');
    const stats = parseNumstatZ(numstat.stdout);
    const statuses = parseNameStatusZ(names.stdout);
    if (stats.length > L.changedFiles) truncated = true;
    for (const s of stats.slice(0, L.changedFiles)) {
      files.push({
        path: s.path,
        oldPath: s.oldPath,
        status: statuses.get(s.path) ?? (s.oldPath ? 'renamed' : 'modified'),
        additions: s.additions,
        deletions: s.deletions,
        patch: null,
      });
    }
    if (files.length > 0) {
      // One call for every patch; a diff past execFile's buffer rejects and the list stays
      // without patches (the counts above are still right).
      const patch = await exec(git(dir, ['diff', ...DIFF_FLAGS, '--relative', '--patch', ...range])).catch(() => null);
      if (!patch || patch.code !== 0) truncated = true;
      else {
        const chunks = splitPatch(patch.stdout);
        let c = 0;
        for (const f of files) {
          // Same order as --numstat. A header git still quotes (a tab or quote in the name)
          // is not matched: that file goes without a patch and the rest keep theirs.
          let at = c;
          while (at < chunks.length && !chunkIsFor(chunks[at] ?? '', f.path)) at++;
          const chunk = chunks[at];
          if (chunk === undefined) continue;
          c = at + 1;
          if (f.additions === null || isBinaryPatch(chunk)) continue;
          if (chunk.length > L.changePatchChars || chunk.length > budget) {
            truncated = true;
            continue;
          }
          f.patch = chunk;
          budget -= chunk.length;
        }
      }
    }
  }

  // Untracked files are what a worker most often creates; git diff does not list them.
  const others = await exec(git(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).catch(() => null);
  if (others && others.code === 0) {
    // A nested repository is listed as `dir/`: not a file to show.
    const paths = others.stdout.split('\0').filter((p) => p !== '' && !p.endsWith('/'));
    let shown = 0;
    for (const path of paths) {
      if (files.length >= L.changedFiles) {
        truncated = true;
        break;
      }
      const entry: TaskChangedFile = {
        path,
        oldPath: null,
        status: 'untracked',
        additions: null,
        deletions: null,
        patch: null,
      };
      files.push(entry);
      if (shown >= L.untrackedPatches || budget <= 0) {
        truncated = true;
        continue;
      }
      shown++;
      // `--no-index` exits 1 when the files differ (always, against /dev/null).
      const out = await exec(git(dir, ['diff', ...DIFF_FLAGS, '--no-index', '--patch', '--', '/dev/null', path])).catch(
        () => null,
      );
      if (!out || (out.code !== 0 && out.code !== 1)) continue;
      const chunk = out.stdout;
      if (isBinaryPatch(chunk)) continue;
      const counts = countLines(chunk);
      entry.additions = counts.additions;
      entry.deletions = counts.deletions;
      if (chunk.length > L.changePatchChars || chunk.length > budget) {
        truncated = true;
        continue;
      }
      entry.patch = chunk;
      budget -= chunk.length;
    }
  }

  return { since, files, truncated };
}
