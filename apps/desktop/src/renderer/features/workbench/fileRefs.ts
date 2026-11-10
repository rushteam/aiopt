// File references in chat text, resolved so a message can open what it points at.
//
// A reference is what the explorer / file preview put in a draft (workbenchNav.ts):
// `@<folder name>/<relative path>` with an optional `:<line>` or `:<start>-<end>` suffix, in
// backticks when it contains whitespace. Only a reference whose folder name is one of the
// Workbench folders resolves; the result names the folder by id and the file by relative path,
// the same shape the explorer opens (main still confines, caps and refuses symlinks on read).
//
// Agents rarely write that form, so plain paths are found too (`findPathRefs`): an absolute path
// under a folder (matched through its home-shortened display path), `<folder name>/…`, or a
// relative path that may live in any folder. Those are only candidates — the caller links one
// once a folder listing shows the file exists, so a word that merely looks like a path stays text.

import type { LineRange } from './workbenchNav';
import type { MessageSegment } from './draftBlocks';

/** A folder as the resolver needs it. */
export interface RefFolder {
  id: string;
  name: string;
  /** Home-shortened path (`~/code/app`), to resolve absolute paths. */
  displayPath?: string;
}

/** A file a reference points at, and the lines when it names some. */
export interface FileRefTarget {
  folderId: string;
  relPath: string;
  range?: LineRange;
}

/** A reference found in a run of text. */
export interface FileRefMatch extends FileRefTarget {
  index: number;
  length: number;
}

// `@…` in backticks (may hold spaces), or bare up to whitespace / a backtick.
const REF_RE = /`@[^`\n]+`|@[^\s`]+/g;
// Sentence punctuation that follows a bare reference is not part of it.
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"，。；：！？）」』、]+$/u;

/** Resolve one reference token (`@app/src/a.ts:3-8`, optionally backticked) against `folders`. */
export function parseFileRef(token: string, folders: readonly RefFolder[]): FileRefTarget | null {
  let ref = token.trim();
  if (ref.length > 2 && ref.startsWith('`') && ref.endsWith('`')) ref = ref.slice(1, -1);
  if (!ref.startsWith('@')) return null;
  ref = ref.slice(1);
  // The longest folder name that prefixes the reference wins (`app` vs `app/web`).
  let folder: RefFolder | null = null;
  for (const f of folders) {
    if (f.name !== '' && ref.startsWith(`${f.name}/`) && (!folder || f.name.length > folder.name.length)) folder = f;
  }
  if (!folder) return null;
  let relPath = ref.slice(folder.name.length + 1);
  let range: LineRange | undefined;
  const lines = /:(\d{1,7})(?:-(\d{1,7}))?$/.exec(relPath);
  if (lines) {
    const start = Number(lines[1]);
    const end = lines[2] ? Number(lines[2]) : start;
    if (start >= 1 && end >= start) range = { start, end };
    relPath = relPath.slice(0, lines.index);
  }
  relPath = relPath.replace(/\/+$/, '');
  if (relPath === '' || relPath.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  return range ? { folderId: folder.id, relPath, range } : { folderId: folder.id, relPath };
}

/** A plain path in text and the files it may be (in preference order); see `findPathRefs`. */
export interface PathRefMatch {
  index: number;
  length: number;
  /** An explicit `@folder/path` reference: links without an existence check. */
  explicit: boolean;
  targets: FileRefTarget[];
}

export const PATH_REFS_MAX = 24;

// A backticked span, or a run of non-space characters outside CJK text / brackets / quotes.
const TOKEN_RE =
  /`[^`\n]{1,400}`|[^\s`'"<>()[\]{}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。；：！？、（）「」『』【】]+/gu;
const LINE_SUFFIX_RE = /(?:#L(\d{1,7})(?:-L?(\d{1,7}))?|:(\d{1,7})(?:-(\d{1,7})|:\d{1,7})?)$/;
// Path-shaped: letters, digits and the usual file-name punctuation, with `/` `\` separators.
const PATH_CHARS_RE = /^(?:[A-Za-z]:)?[\p{L}\p{N}_\-.~/\\+@=,]+$/u;
const FILE_EXT_RE = /[\p{L}\p{N}_\-]\.[A-Za-z][A-Za-z0-9]{0,9}$/u;

function lineSuffix(path: string): { path: string; range?: LineRange } {
  const m = LINE_SUFFIX_RE.exec(path);
  if (!m) return { path };
  const start = Number(m[1] ?? m[3]);
  const endRaw = m[2] ?? m[4];
  const end = endRaw ? Number(endRaw) : start;
  const rest = path.slice(0, m.index);
  return start >= 1 && end >= start ? { path: rest, range: { start, end } } : { path: rest };
}

function cleanRel(rel: string): string | null {
  const r = rel.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (r === '' || r.split('/').some((p) => p === '' || p === '.' || p === '..')) return null;
  return r;
}

/** Folder-relative candidates for one path-shaped token (already without its line suffix). */
function pathTargets(raw: string, folders: readonly RefFolder[]): Omit<FileRefTarget, 'range'>[] {
  const path = raw.replace(/\\/g, '/');
  const absolute = /^(?:\/|~\/|[A-Za-z]:\/)/.test(path);
  if (absolute) {
    let best: { f: RefFolder; rel: string; len: number } | null = null;
    for (const f of folders) {
      const d = (f.displayPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
      if (d === '') continue;
      let rel: string | null = null;
      if (path.startsWith(`${d}/`)) rel = path.slice(d.length + 1);
      else if (d.startsWith('~/')) {
        // `~/code/app` shown, `/Users/me/code/app/…` written: a home directory, then the tail.
        const tail = d.slice(1);
        const at = path.indexOf(`${tail}/`);
        if (at > 0 && /^(?:\/(?:Users|home)\/[^/]+|[A-Za-z]:\/Users\/[^/]+|\/root)$/.test(path.slice(0, at))) {
          rel = path.slice(at + tail.length + 1);
        }
      }
      const clean = rel === null ? null : cleanRel(rel);
      if (clean && (!best || d.length > best.len)) best = { f, rel: clean, len: d.length };
    }
    return best ? [{ folderId: best.f.id, relPath: best.rel }] : [];
  }
  const rel = cleanRel(path);
  if (!rel) return [];
  const out: Omit<FileRefTarget, 'range'>[] = [];
  const first = rel.split('/')[0]!;
  // `<folder name>/…` most likely names that folder; else the path may be in any folder.
  for (const f of folders) {
    if (f.name === first && rel.length > first.length)
      out.push({ folderId: f.id, relPath: rel.slice(first.length + 1) });
  }
  for (const f of folders) out.push({ folderId: f.id, relPath: rel });
  return out;
}

/**
 * Every reference in `text`: explicit `@folder/path` ones, and plain paths with the files they
 * may be. A plain path needs a `/` or a file extension; URLs are skipped.
 */
export function findPathRefs(text: string, folders: readonly RefFolder[]): PathRefMatch[] {
  if (folders.length === 0) return [];
  const explicit = findFileRefs(text, folders);
  const out: PathRefMatch[] = explicit.map(({ index, length, ...target }) => ({
    index,
    length,
    explicit: true,
    targets: [target],
  }));
  const overlaps = (from: number, to: number): boolean =>
    explicit.some((ex) => ex.index < to && from < ex.index + ex.length);
  for (const m of text.matchAll(TOKEN_RE)) {
    if (out.length >= PATH_REFS_MAX) break;
    const index = m.index ?? 0;
    let token = m[0];
    if (overlaps(index, index + token.length)) continue;
    const quoted = token.startsWith('`');
    let inner = quoted ? token.slice(1, -1).trim() : token.replace(TRAILING_PUNCT_RE, '');
    if (!quoted) token = inner;
    if (inner === '' || inner.includes('://') || inner.startsWith('@')) continue;
    const { path, range } = lineSuffix(inner);
    inner = path;
    // Only files link; a trailing separator names a directory.
    if (!PATH_CHARS_RE.test(inner) || /[/\\]$/.test(inner)) continue;
    if (!/[/\\]/.test(inner) && !FILE_EXT_RE.test(inner)) continue;
    const targets = pathTargets(inner, folders).map((t) => (range ? { ...t, range } : t));
    if (targets.length > 0) out.push({ index, length: token.length, explicit: false, targets });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Every resolvable reference in `text`, in order. */
export function findFileRefs(text: string, folders: readonly RefFolder[]): FileRefMatch[] {
  if (folders.length === 0 || !text.includes('@')) return [];
  const out: FileRefMatch[] = [];
  for (const m of text.matchAll(REF_RE)) {
    const index = m.index ?? 0;
    // `a@b` (an e-mail, a version pin) is not a reference.
    if (index > 0 && /[\w.@]/.test(text[index - 1]!)) continue;
    let raw = m[0];
    if (!raw.startsWith('`')) raw = raw.replace(TRAILING_PUNCT_RE, '');
    const target = parseFileRef(raw, folders);
    if (target) out.push({ ...target, index, length: raw.length });
  }
  return out;
}

/**
 * Where code segment `i` came from: a quoted line range is the reference line right before its
 * fence (see `lineQuoteText`), so the text segment before it ending in a reference names it.
 */
export function codeSource(
  segments: readonly MessageSegment[],
  i: number,
  folders: readonly RefFolder[],
): FileRefTarget | null {
  const prev = segments[i - 1];
  if (!prev || prev.kind !== 'text') return null;
  const lastLine = (prev.text.split('\n').pop() ?? '').trimEnd();
  const last = findFileRefs(lastLine, folders).pop();
  if (!last || last.index + last.length !== lastLine.length) return null;
  return last.range
    ? { folderId: last.folderId, relPath: last.relPath, range: last.range }
    : { folderId: last.folderId, relPath: last.relPath };
}
