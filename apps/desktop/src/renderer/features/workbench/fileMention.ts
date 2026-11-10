// The file half of the `@` picker: `@` lists the workbench folders, `@app/` the folder's top
// level, `@app/src/ma` the entries of `app/src` matching "ma" — like a shell's path completion.
// Picking a directory keeps browsing; picking a file (or "this directory") inserts the same
// `@folder/path` reference the explorer's "insert" button writes. Listings come from the
// existing read-only folder-list IPC, one directory at a time. Pure; no DOM, no IPC.

import type { FolderEntry } from '../../../shared/workbench';
import type { MentionOption } from './mentionSuggest';
import { folderMentionText } from './workbenchNav';

export interface MentionFolder {
  id: string;
  name: string;
}

export const MENTION_FOLDERS_MAX = 4;
export const MENTION_ENTRIES_MAX = 40;

/** The directory a path query browses, or null when the query names no folder yet. */
export interface FileMentionDir {
  folder: MentionFolder;
  /** `/`-separated, '' for the folder root. */
  dirRel: string;
  /** What is typed after the last `/`. */
  partial: string;
}

export const listingKey = (folderId: string, dirRel: string): string => `${folderId}\u0000${dirRel}`;

/** `app/src/ma` → folder `app`, dir `src`, partial `ma`. The longest matching folder name wins. */
export function fileMentionDir(query: string, folders: readonly MentionFolder[]): FileMentionDir | null {
  let best: MentionFolder | null = null;
  for (const f of folders) {
    if (query.startsWith(`${f.name}/`) && (!best || f.name.length > best.name.length)) best = f;
  }
  if (!best) return null;
  const rest = query.slice(best.name.length + 1);
  const cut = rest.lastIndexOf('/');
  const dirRel = cut < 0 ? '' : rest.slice(0, cut);
  if (dirRel !== '' && dirRel.split('/').some((p) => p === '' || p === '.' || p === '..')) return null;
  return { folder: best, dirRel, partial: cut < 0 ? rest : rest.slice(cut + 1) };
}

const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

function rank(name: string, partial: string): number {
  if (!partial) return 0;
  const n = name.toLowerCase();
  if (n.startsWith(partial)) return 0;
  return n.includes(partial) ? 1 : -1;
}

/**
 * Picker options for `query`. `listing` returns a loaded directory listing (undefined while it
 * is not loaded yet). With no folder named, folders matching the query are offered.
 */
export function fileMentionOptions(
  query: string,
  folders: readonly MentionFolder[],
  listing: (folderId: string, dirRel: string) => readonly FolderEntry[] | undefined,
  dirTag: string,
): MentionOption[] {
  const dir = fileMentionDir(query, folders);
  if (!dir) {
    const q = query.toLowerCase();
    return folders
      .filter((f) => f.name.toLowerCase().includes(q))
      .slice(0, MENTION_FOLDERS_MAX)
      .map((f) => ({
        key: `folder:${f.id}`,
        kind: 'dir' as const,
        token: `@${f.name}/`,
        browse: true,
        label: `${f.name}/`,
        detail: dirTag,
      }));
  }
  const { folder, dirRel, partial } = dir;
  const out: MentionOption[] = [];
  if (dirRel !== '' && partial === '') {
    // "This directory": reference the directory itself.
    out.push({
      key: `dir:${folder.id}:${dirRel}`,
      kind: 'dir',
      token: folderMentionText(folder.name, dirRel),
      label: `${dirRel}/`,
      detail: folder.name,
    });
  }
  const entries = listing(folder.id, dirRel);
  if (!entries) return out;
  const p = partial.toLowerCase();
  const matched = entries
    .map((e) => ({ e, r: rank(e.name, p) }))
    .filter((m) => m.r >= 0)
    .sort((a, b) => a.r - b.r)
    .slice(0, MENTION_ENTRIES_MAX);
  for (const { e } of matched) {
    const rel = join(dirRel, e.name);
    if (e.kind === 'dir') {
      out.push({
        key: `dir:${folder.id}:${rel}`,
        kind: 'dir',
        token: `@${folder.name}/${rel}/`,
        browse: true,
        label: `${e.name}/`,
        detail: join(folder.name, dirRel),
      });
    } else {
      out.push({
        key: `file:${folder.id}:${rel}`,
        kind: 'file',
        token: folderMentionText(folder.name, rel),
        label: e.name,
        detail: join(folder.name, dirRel),
      });
    }
  }
  return out;
}
