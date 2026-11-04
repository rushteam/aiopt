// File operations behind the Workbench explorer: new file / folder, rename, move to trash,
// copy / move (within or across granted folders), import from the OS file manager, copy path.
//
// The renderer names every entry as `{folderId, relPath}` — never an absolute path — and this
// module re-checks all of it in MAIN before touching disk:
//  - Both ends are confined to a granted folder. Every component of a path is `lstat`ed, so a
//    symlink anywhere in the chain refuses (a planted link cannot redirect a write out of the
//    folder), and the entry itself must be a regular file or a directory.
//  - The entries the tree hides (`.git`, `node_modules`, `.DS_Store`) can be neither a source,
//    a destination, nor a new name.
//  - Nothing is overwritten: copy / move / import pick a free `name copy.ext` name, create and
//    rename refuse with ALREADY_EXISTS. Delete is move-to-trash only (`shell.trashItem`).
//  - A recursive copy is planned first (symlinks skipped, entry and byte caps enforced) and only
//    then executed, so an oversized copy writes nothing and a folder cannot be copied into its
//    own subtree. A failed copy removes only what it created.
//  - Absolute paths dropped from the OS file manager are the one renderer-supplied absolute path
//    accepted, and only behind a native confirmation main shows itself.
//
// Electron-free (trash, confirm and clipboard are injected) so it is unit-tested on a real temp
// directory on every platform.

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { throwIpcError } from '../ipc/validate';
import { isIpcError } from '../../shared/ipc-errors';
import { WORKBENCH_LIMITS, isValidFolderRelPath, isValidFolderSegment } from '../../shared/workbench';
import type { Logger } from '../logger';

/** Bulky or internal entries the file tree never lists, and the operations never touch. */
export const FOLDER_TREE_HIDDEN: ReadonlySet<string> = new Set(['.git', 'node_modules', '.DS_Store']);

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_UNIQUE_TRIES = 1000;

export interface FolderImportConfirm {
  /** The granted folder's display name. */
  folderName: string;
  /** Destination directory, relative to the folder ('' = its root). */
  relPath: string;
  /** Absolute paths that will be copied. */
  paths: string[];
}

export interface FolderOpsDeps {
  platform: NodeJS.Platform;
  /** The granted folder's canonical root and name; throws NOT_FOUND for an unknown id. */
  folder(folderId: string): { root: string; name: string };
  /** Move an absolute path to the OS trash (`shell.trashItem`). */
  trash(absolutePath: string): Promise<void>;
  /** Native confirmation before a drop from the OS file manager is copied. */
  confirmImport(req: FolderImportConfirm): Promise<boolean>;
  writeClipboard(text: string): void;
  logger: Logger;
  /** Test seam. */
  fs?: typeof nodeFs;
}

export interface FolderOps {
  create(folderId: string, dirRel: string, name: string, kind: 'file' | 'dir'): string;
  rename(folderId: string, relPath: string, name: string): string;
  trash(folderId: string, relPath: string): Promise<void>;
  transfer(op: 'copy' | 'move', from: EntryRef, to: EntryRef): string;
  importPaths(folderId: string, dirRel: string, paths: readonly string[]): Promise<string[]>;
  copyPath(folderId: string, relPath: string, relative: boolean): void;
}

export interface EntryRef {
  folderId: string;
  relPath: string;
}

interface Resolved {
  root: string;
  abs: string;
  kind: 'file' | 'dir';
  segments: string[];
}

interface PlanItem {
  /** Path segments below the copied entry ([] = the entry itself). */
  rel: string[];
  kind: 'file' | 'dir';
}

const join = (base: string, rel: string): string => (base === '' ? rel : `${base}/${rel}`);

function errnoCode(err: unknown): string {
  return err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : 'unknown';
}

/** `child` is `parent` itself or below it (segment-wise; a different drive is outside). */
function isWithin(parent: string, child: string, caseFold: boolean): boolean {
  const a = caseFold ? parent.toLowerCase() : parent;
  const b = caseFold ? child.toLowerCase() : child;
  const rel = nodePath.relative(a, b);
  if (rel === '') return true;
  if (nodePath.isAbsolute(rel)) return false;
  return rel.split(nodePath.sep)[0] !== '..';
}

/** `notes.txt` → `notes copy.txt`, then `notes copy 2.txt`, … (a directory has no extension). */
export function copyName(name: string, kind: 'file' | 'dir', n: number): string {
  const ext = kind === 'file' ? nodePath.extname(name) : '';
  const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
  const suffix = n <= 1 ? ' copy' : ` copy ${n}`;
  return `${base}${suffix}${ext === name ? '' : ext}`;
}

export function createFolderOps(deps: FolderOpsDeps): FolderOps {
  const fs = deps.fs ?? nodeFs;
  const caseFold = deps.platform === 'darwin' || deps.platform === 'win32';
  const log = deps.logger;

  function lstat(p: string): nodeFs.Stats | null {
    try {
      return fs.lstatSync(p);
    } catch {
      return null;
    }
  }

  /** A name a new entry may get: listable by the tree, not hidden, portable. */
  function requireName(name: string): string {
    if (!isValidFolderSegment(name) || FOLDER_TREE_HIDDEN.has(name)) throwIpcError('INVALID_PARAMS', 'invalid name');
    if (name.trim() !== name || /[. ]$/.test(name)) throwIpcError('INVALID_PARAMS', 'invalid name');
    if (deps.platform === 'win32' && (/[<>"|?*]/.test(name) || WINDOWS_RESERVED.test(name))) {
      throwIpcError('INVALID_PARAMS', 'invalid name');
    }
    return name;
  }

  /** An existing entry of a granted folder, with no symlink anywhere on the way. */
  function resolve(ref: EntryRef): Resolved {
    const { root } = deps.folder(ref.folderId);
    if (!isValidFolderRelPath(ref.relPath)) throwIpcError('INVALID_PARAMS', 'invalid relPath');
    const segments = ref.relPath === '' ? [] : ref.relPath.split('/');
    if (segments.some((s) => FOLDER_TREE_HIDDEN.has(s))) throwIpcError('NOT_FOUND', 'entry not found');
    let abs = root;
    let st = lstat(root);
    for (const seg of segments) {
      if (!st?.isDirectory()) throwIpcError('NOT_FOUND', 'entry not found');
      abs = nodePath.join(abs, seg);
      st = lstat(abs);
    }
    if (!st || (!st.isDirectory() && !st.isFile())) throwIpcError('NOT_FOUND', 'entry not found');
    return { root, abs, kind: st.isDirectory() ? 'dir' : 'file', segments };
  }

  function resolveDir(ref: EntryRef): Resolved {
    const r = resolve(ref);
    if (r.kind !== 'dir') throwIpcError('INVALID_PARAMS', 'not a directory');
    return r;
  }

  function resolveEntry(ref: EntryRef): Resolved {
    if (ref.relPath === '') throwIpcError('INVALID_PARAMS', 'the folder itself');
    return resolve(ref);
  }

  /** `name` in `dirAbs`, or the first free `name copy…` when it is taken. */
  function freeName(dirAbs: string, name: string, kind: 'file' | 'dir'): string {
    if (!lstat(nodePath.join(dirAbs, name))) return name;
    for (let n = 1; n <= MAX_UNIQUE_TRIES; n += 1) {
      const candidate = copyName(name, kind, n);
      if (candidate.length <= 255 && !lstat(nodePath.join(dirAbs, candidate))) return candidate;
    }
    throwIpcError('ALREADY_EXISTS', 'no free name');
  }

  /** Every entry below `abs` (symlinks and specials skipped), within the copy caps. */
  function plan(abs: string, kind: 'file' | 'dir', budget: { entries: number; bytes: number }): PlanItem[] {
    const items: PlanItem[] = [];
    const visit = (p: string, rel: string[], k: 'file' | 'dir'): void => {
      budget.entries += 1;
      if (budget.entries > WORKBENCH_LIMITS.copyEntries) throwIpcError('PRECONDITION_FAILED', 'too many entries');
      if (rel.length > WORKBENCH_LIMITS.folderRelDepth) throwIpcError('PRECONDITION_FAILED', 'too deep');
      items.push({ rel, kind: k });
      if (k === 'file') {
        budget.bytes += lstat(p)?.size ?? 0;
        if (budget.bytes > WORKBENCH_LIMITS.copyBytes) throwIpcError('PRECONDITION_FAILED', 'too large');
        return;
      }
      let names: string[];
      try {
        names = fs.readdirSync(p);
      } catch {
        throwIpcError('NOT_FOUND', 'unreadable directory');
      }
      for (const name of names.sort()) {
        const child = nodePath.join(p, name);
        const st = lstat(child);
        if (!st || st.isSymbolicLink()) continue;
        if (st.isDirectory()) visit(child, [...rel, name], 'dir');
        else if (st.isFile()) visit(child, [...rel, name], 'file');
      }
    };
    visit(abs, [], kind);
    return items;
  }

  /** Execute a plan into `dst` (which must not exist). On failure, removes what it created. */
  function copyPlan(src: string, dst: string, items: readonly PlanItem[]): void {
    try {
      for (const item of items) {
        const from = nodePath.join(src, ...item.rel);
        const to = nodePath.join(dst, ...item.rel);
        if (item.kind === 'dir') fs.mkdirSync(to);
        // COPYFILE_EXCL: never overwrite, even if something appeared since the plan.
        else fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      }
    } catch (err) {
      if (lstat(dst)) {
        try {
          fs.rmSync(dst, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup of our own partial copy.
        }
      }
      log.warn('workbench.folder_copy_failed', { code: errnoCode(err) });
      if (isIpcError(err)) throw err;
      throwIpcError(errnoCode(err) === 'EEXIST' ? 'ALREADY_EXISTS' : 'INTERNAL', 'copy failed');
    }
  }

  function relOf(dir: Resolved, name: string): string {
    return join(dir.segments.join('/'), name);
  }

  function create(folderId: string, dirRel: string, name: string, kind: 'file' | 'dir'): string {
    const dir = resolveDir({ folderId, relPath: dirRel });
    requireName(name);
    const rel = relOf(dir, name);
    if (!isValidFolderRelPath(rel)) throwIpcError('INVALID_PARAMS', 'path too long');
    const abs = nodePath.join(dir.abs, name);
    try {
      if (kind === 'dir') fs.mkdirSync(abs);
      else fs.writeFileSync(abs, '', { flag: 'wx' });
    } catch (err) {
      if (errnoCode(err) === 'EEXIST') throwIpcError('ALREADY_EXISTS', 'entry exists');
      log.warn('workbench.folder_create_failed', { code: errnoCode(err) });
      throwIpcError('INTERNAL', 'create failed');
    }
    return rel;
  }

  function rename(folderId: string, relPath: string, name: string): string {
    const src = resolveEntry({ folderId, relPath });
    requireName(name);
    const parentRel = src.segments.slice(0, -1).join('/');
    const rel = join(parentRel, name);
    if (!isValidFolderRelPath(rel)) throwIpcError('INVALID_PARAMS', 'path too long');
    const oldName = src.segments.at(-1) ?? '';
    if (name === oldName) return relPath;
    const target = nodePath.join(nodePath.dirname(src.abs), name);
    const existing = lstat(target);
    // A case-only rename on a case-insensitive disk finds the entry itself: allowed.
    const self = existing !== null && caseFold && name.toLowerCase() === oldName.toLowerCase();
    if (existing && !self) throwIpcError('ALREADY_EXISTS', 'entry exists');
    try {
      fs.renameSync(src.abs, target);
    } catch (err) {
      log.warn('workbench.folder_rename_failed', { code: errnoCode(err) });
      throwIpcError('INTERNAL', 'rename failed');
    }
    return rel;
  }

  async function trash(folderId: string, relPath: string): Promise<void> {
    const src = resolveEntry({ folderId, relPath });
    try {
      await deps.trash(src.abs);
    } catch (err) {
      log.warn('workbench.folder_trash_failed', { code: errnoCode(err) });
      throwIpcError('INTERNAL', 'trash failed');
    }
  }

  function transfer(op: 'copy' | 'move', from: EntryRef, to: EntryRef): string {
    const src = resolveEntry(from);
    const dir = resolveDir(to);
    if (src.kind === 'dir' && isWithin(src.abs, dir.abs, caseFold)) {
      throwIpcError('INVALID_PARAMS', 'into itself');
    }
    const name = src.segments.at(-1) ?? '';
    const sameDir = nodePath.dirname(src.abs) === dir.abs;
    if (op === 'move' && sameDir) return from.relPath;
    const finalName = freeName(dir.abs, name, src.kind);
    const rel = relOf(dir, finalName);
    if (!isValidFolderRelPath(rel)) throwIpcError('INVALID_PARAMS', 'path too long');
    const dst = nodePath.join(dir.abs, finalName);
    const items = () => plan(src.abs, src.kind, { entries: 0, bytes: 0 });
    if (op === 'copy') {
      copyPlan(src.abs, dst, items());
      return rel;
    }
    try {
      fs.renameSync(src.abs, dst);
    } catch (err) {
      // Two granted folders on different volumes: copy, then remove the source.
      if (errnoCode(err) !== 'EXDEV') {
        log.warn('workbench.folder_move_failed', { code: errnoCode(err) });
        throwIpcError('INTERNAL', 'move failed');
      }
      copyPlan(src.abs, dst, items());
      fs.rmSync(src.abs, { recursive: true, force: true });
    }
    return rel;
  }

  async function importPaths(folderId: string, dirRel: string, paths: readonly string[]): Promise<string[]> {
    const dir = resolveDir({ folderId, relPath: dirRel });
    const unique = [...new Set(paths)];
    if (unique.length === 0 || unique.length > WORKBENCH_LIMITS.importPaths) throwIpcError('INVALID_PARAMS', 'paths');
    const sources: { abs: string; name: string; kind: 'file' | 'dir'; items: PlanItem[] }[] = [];
    const budget = { entries: 0, bytes: 0 };
    for (const raw of unique) {
      if (raw.length > WORKBENCH_LIMITS.importPathChars || !nodePath.isAbsolute(raw)) {
        throwIpcError('INVALID_PARAMS', 'invalid path');
      }
      const abs = nodePath.resolve(raw);
      const name = nodePath.basename(abs);
      const st = lstat(abs);
      if (!st || (!st.isFile() && !st.isDirectory())) throwIpcError('NOT_FOUND', 'source not found');
      if (!isValidFolderSegment(name) || FOLDER_TREE_HIDDEN.has(name)) throwIpcError('INVALID_PARAMS', 'invalid name');
      const kind = st.isDirectory() ? 'dir' : 'file';
      if (kind === 'dir' && isWithin(abs, dir.abs, caseFold)) throwIpcError('INVALID_PARAMS', 'into itself');
      sources.push({ abs, name, kind, items: plan(abs, kind, budget) });
    }
    const { name: folderName } = deps.folder(folderId);
    const ok = await deps.confirmImport({ folderName, relPath: dir.segments.join('/'), paths: sources.map((s) => s.abs) });
    if (!ok) return [];
    // Re-check the destination after the (async) dialog: it may have changed meanwhile.
    const target = resolveDir({ folderId, relPath: dirRel });
    const out: string[] = [];
    for (const s of sources) {
      const finalName = freeName(target.abs, s.name, s.kind);
      const rel = relOf(target, finalName);
      if (!isValidFolderRelPath(rel)) throwIpcError('INVALID_PARAMS', 'path too long');
      copyPlan(s.abs, nodePath.join(target.abs, finalName), s.items);
      out.push(rel);
    }
    log.info('workbench.folder_import', { count: out.length });
    return out;
  }

  function copyPath(folderId: string, relPath: string, relative: boolean): void {
    const r = resolve({ folderId, relPath });
    deps.writeClipboard(relative ? (r.segments.length ? r.segments.join(nodePath.sep) : '.') : r.abs);
  }

  return { create, rename, trash, transfer, importPaths, copyPath };
}
