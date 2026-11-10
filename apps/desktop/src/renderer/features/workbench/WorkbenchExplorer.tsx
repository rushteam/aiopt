// The Workbench's right explorer: the folders granted to the workbench, each a lazily expanded
// file tree. Clicking a file opens its read-only preview in the content area. Like a code
// editor's explorer it also edits the tree: a right-click menu (new file / folder, rename, move
// to trash, cut / copy / paste, copy path, reveal), the matching keyboard shortcuts while the
// tree has focus, drag-to-move (Option / Alt copies), and drop-in from the OS file manager.
//
// Capability-free: every listing and every operation is a named `workbench:folder-*` call with
// the folder's opaque id and relative paths; main resolves both ends inside granted folders,
// refuses symlinks and hidden entries, never overwrites (a taken name gets ` copy`), deletes
// only to the OS trash, and confirms a drop from the file manager in a native dialog. The
// in-app clipboard holds `{folderId, relPath}` only. Collapsed, it is a 40px rail.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { disabledOpacity, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import {
  addFolder,
  copyFolderEntryPath,
  createFolderEntry,
  importDroppedFiles,
  listFolder,
  removeFolder,
  renameFolderEntry,
  revealFolderEntry,
  transferFolderEntry,
  trashFolderEntry,
} from '../../lib/workbenchStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { WORKBENCH_LIMITS, type FolderListing, type FolderView } from '../../../shared/workbench';
import { ChevronIcon, CloseIcon, FileIcon, FolderIcon, PanelIcon, PlusIcon, RefreshIcon } from './workbenchIcons';
import { IconButton } from './workbenchPanes';
import { ExplorerContextMenu, type ContextMenuItem } from './ExplorerContextMenu';
// Drag payload of a tree row (in-app only; never a path main has not granted).
import { ENTRY_DRAG_TYPE } from './entryDrag';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

type Listing = { state: 'loading' } | { state: 'ready'; listing: FolderListing } | { state: 'error' };

/** One row of the tree: a granted folder's root (`relPath` ''), a directory, or a file. */
interface Target {
  folderId: string;
  relPath: string;
  kind: 'file' | 'dir';
}

type Editing =
  | { mode: 'rename'; folderId: string; relPath: string; kind: 'file' | 'dir' }
  | { mode: 'new'; folderId: string; dirRel: string; kind: 'file' | 'dir' };

const listingKey = (folderId: string, relPath: string): string => `${folderId}\u0000${relPath}`;
const joinRel = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
const parentRel = (relPath: string): string => (relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '');
const baseName = (relPath: string): string => relPath.slice(relPath.lastIndexOf('/') + 1);
const sameTarget = (a: { folderId: string; relPath: string } | null, b: { folderId: string; relPath: string }): boolean =>
  a !== null && a.folderId === b.folderId && a.relPath === b.relPath;
/** `relPath` is `base` itself or below it. */
const isUnder = (relPath: string, base: string): boolean => base === '' || relPath === base || relPath.startsWith(`${base}/`);

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
const shortcut = (key: string): string => (IS_MAC ? `⌘${key}` : `Ctrl+${key}`);

export function WorkbenchExplorer({
  folders,
  t,
  run,
  collapsed,
  onToggleCollapsed,
  onOpenFile,
  onInsertFile,
  onPathChanged,
  selectedFile,
}: {
  folders: readonly FolderView[];
  t: TranslateFn;
  run: Runner;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** A file was picked: preview it in the content area. */
  onOpenFile: (folder: FolderView, relPath: string) => void;
  /** "Reference in chat" for a file or directory. */
  onInsertFile: (folder: FolderView, relPath: string) => void;
  /** An entry was renamed / moved (`to`) or trashed (`to` null), so a preview can follow it. */
  onPathChanged: (folderId: string, from: string, to: { folderId: string; relPath: string } | null) => void;
  /** The file being previewed, highlighted in the tree. */
  selectedFile: { folderId: string; relPath: string } | null;
}) {
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const listingsRef = useRef(listings);
  listingsRef.current = listings;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [confirmRemove, setConfirmRemove] = useState<FolderView | null>(null);
  const [confirmTrash, setConfirmTrash] = useState<Target | null>(null);
  const [selected, setSelected] = useState<Target | null>(null);
  const [clip, setClip] = useState<(Target & { cut: boolean }) | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; target: Target } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const dragging = useRef<Target | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const full = folders.length >= WORKBENCH_LIMITS.folders;
  // A late reply for a listing the user refreshed past is dropped.
  const generation = useRef(0);
  const folderById = (id: string): FolderView | undefined => folders.find((f) => f.id === id);

  const load = useCallback((folderId: string, relPath: string) => {
    const key = listingKey(folderId, relPath);
    const gen = generation.current;
    setListings((m) => ({ ...m, [key]: m[key]?.state === 'ready' ? m[key] : { state: 'loading' } }));
    listFolder(folderId, relPath).then(
      (listing) => {
        if (gen === generation.current) setListings((m) => ({ ...m, [key]: { state: 'ready', listing } }));
      },
      () => {
        if (gen === generation.current) setListings((m) => ({ ...m, [key]: { state: 'error' } }));
      },
    );
  }, []);

  const toggle = (folderId: string, relPath: string): void => {
    const key = listingKey(folderId, relPath);
    const next = !open[key];
    setOpen((m) => ({ ...m, [key]: next }));
    if (next && listings[key]?.state !== 'ready') load(folderId, relPath);
  };

  /** Open a directory (and list it) so a new / pasted entry shows up. */
  const reveal = (folderId: string, dirRel: string): void => {
    setOpen((m) => ({ ...m, [listingKey(folderId, dirRel)]: true }));
    load(folderId, dirRel);
  };

  /** Re-list a directory after an operation changed it (only if it was listed). */
  const relist = (folderId: string, dirRel: string): void => {
    if (listingsRef.current[listingKey(folderId, dirRel)]) load(folderId, dirRel);
  };

  // Re-list every open directory (files change under the workers).
  const refresh = (): void => {
    generation.current += 1;
    setListings({});
    for (const [key, isOpen] of Object.entries(open)) {
      if (!isOpen) continue;
      const [folderId, relPath = ''] = key.split('\u0000');
      if (folderId) load(folderId, relPath);
    }
  };

  // Drop the state of folders that were removed.
  useEffect(() => {
    const ids = new Set(folders.map((f) => f.id));
    const live = (k: string): boolean => ids.has(k.split('\u0000')[0] ?? '');
    setOpen((m) => (Object.keys(m).every(live) ? m : Object.fromEntries(Object.entries(m).filter(([k]) => live(k)))));
    setListings((m) => (Object.keys(m).every(live) ? m : Object.fromEntries(Object.entries(m).filter(([k]) => live(k)))));
    setSelected((s) => (s && !ids.has(s.folderId) ? null : s));
    setClip((c) => (c && !ids.has(c.folderId) ? null : c));
  }, [folders]);

  // A lone folder starts expanded the first time the explorer shows it.
  const autoOpened = useRef(new Set<string>());
  useEffect(() => {
    const only = folders.length === 1 ? folders[0] : undefined;
    if (collapsed || !only || autoOpened.current.has(only.id)) return;
    autoOpened.current.add(only.id);
    setOpen((m) => ({ ...m, [listingKey(only.id, '')]: true }));
    load(only.id, '');
  }, [folders, collapsed, load]);

  // ── Operations (each one named IPC call; main validates and confines it) ──

  /** The directory an action on `target` lands in: itself if a directory, else its parent. */
  const dirOf = (target: Target): string => (target.kind === 'dir' ? target.relPath : parentRel(target.relPath));

  const startNew = (target: Target, kind: 'file' | 'dir'): void => {
    const dirRel = dirOf(target);
    reveal(target.folderId, dirRel);
    setEditing({ mode: 'new', folderId: target.folderId, dirRel, kind });
  };

  const commitEdit = (value: string): void => {
    const edit = editing;
    setEditing(null);
    const name = value.trim();
    if (!edit || name === '') return;
    if (edit.mode === 'new') {
      void run(async () => {
        const rel = await createFolderEntry(edit.folderId, edit.dirRel, name, edit.kind);
        reveal(edit.folderId, edit.dirRel);
        setSelected({ folderId: edit.folderId, relPath: rel, kind: edit.kind });
        const folder = folderById(edit.folderId);
        if (edit.kind === 'file' && folder) onOpenFile(folder, rel);
      });
      return;
    }
    if (name === baseName(edit.relPath)) return;
    void run(async () => {
      const rel = await renameFolderEntry(edit.folderId, edit.relPath, name);
      relist(edit.folderId, parentRel(edit.relPath));
      setSelected({ folderId: edit.folderId, relPath: rel, kind: edit.kind });
      onPathChanged(edit.folderId, edit.relPath, { folderId: edit.folderId, relPath: rel });
    });
  };

  const transfer = (op: 'copy' | 'move', from: Target, to: { folderId: string; dirRel: string }): void => {
    if (op === 'move' && from.folderId === to.folderId && parentRel(from.relPath) === to.dirRel) return;
    void run(async () => {
      const rel = await transferFolderEntry(op, from, { folderId: to.folderId, relPath: to.dirRel });
      if (op === 'move') {
        relist(from.folderId, parentRel(from.relPath));
        onPathChanged(from.folderId, from.relPath, { folderId: to.folderId, relPath: rel });
      }
      reveal(to.folderId, to.dirRel);
      setSelected({ folderId: to.folderId, relPath: rel, kind: from.kind });
    });
  };

  const paste = (target: Target): void => {
    if (!clip) return;
    transfer(clip.cut ? 'move' : 'copy', clip, { folderId: target.folderId, dirRel: dirOf(target) });
    if (clip.cut) setClip(null);
  };

  const trash = (target: Target): void => {
    void run(async () => {
      await trashFolderEntry(target.folderId, target.relPath);
      relist(target.folderId, parentRel(target.relPath));
      if (selected && selected.folderId === target.folderId && isUnder(selected.relPath, target.relPath)) setSelected(null);
      if (clip && clip.folderId === target.folderId && isUnder(clip.relPath, target.relPath)) setClip(null);
      onPathChanged(target.folderId, target.relPath, null);
    });
  };

  const importFiles = (folderId: string, dirRel: string, files: FileList): void => {
    if (files.length === 0) return;
    const list = Array.from(files);
    void run(async () => {
      const rels = await importDroppedFiles(folderId, dirRel, list);
      if (rels.length === 0) return;
      reveal(folderId, dirRel);
      const last = rels[rels.length - 1];
      if (last) setSelected({ folderId, relPath: last, kind: 'file' });
    });
  };

  // ── Context menu ──

  const menuItems = (target: Target): ContextMenuItem[] => {
    const folder = folderById(target.folderId);
    if (!folder) return [];
    const isRoot = target.relPath === '';
    const sep: ContextMenuItem = { kind: 'separator' };
    const items: ContextMenuItem[] = [];
    if (target.kind === 'file') {
      items.push({ kind: 'item', label: t('workbench.explorer.open'), onSelect: () => onOpenFile(folder, target.relPath) });
    } else {
      items.push(
        { kind: 'item', label: t('workbench.explorer.newFile'), onSelect: () => startNew(target, 'file') },
        { kind: 'item', label: t('workbench.explorer.newFolder'), onSelect: () => startNew(target, 'dir') },
      );
    }
    if (!isRoot) {
      items.push({ kind: 'item', label: t('workbench.explorer.insert'), onSelect: () => onInsertFile(folder, target.relPath) });
    }
    items.push(sep);
    if (!isRoot) {
      items.push(
        { kind: 'item', label: t('workbench.explorer.cut'), hint: shortcut('X'), onSelect: () => setClip({ ...target, cut: true }) },
        { kind: 'item', label: t('workbench.explorer.copy'), hint: shortcut('C'), onSelect: () => setClip({ ...target, cut: false }) },
      );
    }
    items.push(
      { kind: 'item', label: t('workbench.explorer.paste'), hint: shortcut('V'), disabled: !clip, onSelect: () => paste(target) },
      sep,
      { kind: 'item', label: t('workbench.explorer.copyPath'), onSelect: () => void run(() => copyFolderEntryPath(target.folderId, target.relPath, false)) },
    );
    if (!isRoot) {
      items.push({
        kind: 'item',
        label: t('workbench.explorer.copyRelativePath'),
        onSelect: () => void run(() => copyFolderEntryPath(target.folderId, target.relPath, true)),
      });
    }
    items.push(
      { kind: 'item', label: t('workbench.explorer.reveal'), onSelect: () => void run(() => revealFolderEntry(target.folderId, target.relPath)) },
      sep,
    );
    if (isRoot) {
      items.push({ kind: 'item', label: t('workbench.folders.remove'), danger: true, onSelect: () => setConfirmRemove(folder) });
    } else {
      items.push(
        { kind: 'item', label: t('workbench.explorer.rename'), hint: IS_MAC ? '↩' : 'F2', onSelect: () => setEditing({ mode: 'rename', ...target }) },
        { kind: 'item', label: t('workbench.explorer.trash'), hint: IS_MAC ? '⌘⌫' : 'Del', danger: true, onSelect: () => setConfirmTrash(target) },
      );
    }
    return items;
  };

  const openMenu = (e: ReactMouseEvent, target: Target): void => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(target);
    setMenu({ x: e.clientX, y: e.clientY, target });
  };
  const closeMenu = useCallback(() => setMenu(null), []);

  // ── Keyboard (while the tree has focus) ──

  const onTreeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (editing || !selected || (e.target as HTMLElement).tagName === 'INPUT') return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const isRoot = selected.relPath === '';
    const key = e.key.toLowerCase();
    let handled = true;
    if (mod && key === 'c' && !isRoot) setClip({ ...selected, cut: false });
    else if (mod && key === 'x' && !isRoot) setClip({ ...selected, cut: true });
    else if (mod && key === 'v' && clip) paste(selected);
    else if (!isRoot && (e.key === 'F2' || (IS_MAC && e.key === 'Enter' && !mod))) setEditing({ mode: 'rename', ...selected });
    else if (!isRoot && (e.key === 'Delete' || (IS_MAC && mod && e.key === 'Backspace'))) setConfirmTrash(selected);
    else handled = false;
    if (handled) e.preventDefault();
  };

  // ── Drag and drop ──

  const onDragStart = (e: DragEvent, target: Target): void => {
    dragging.current = target;
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(ENTRY_DRAG_TYPE, JSON.stringify({ folderId: target.folderId, relPath: target.relPath }));
  };
  const onDragEnd = (): void => {
    dragging.current = null;
    setDropKey(null);
  };

  /** Whether the drag over `dir` can land there (not onto itself or its own subtree). */
  const canDropInto = (folderId: string, dirRel: string): boolean => {
    const src = dragging.current;
    if (!src) return true;
    if (src.folderId !== folderId) return true;
    if (src.kind === 'dir' && isUnder(dirRel, src.relPath)) return false;
    return true;
  };

  const dropHandlers = (target: Target) => {
    const folderId = target.folderId;
    const dirRel = dirOf(target);
    const key = listingKey(folderId, dirRel);
    const accepts = (e: DragEvent): 'move' | 'copy' | null => {
      const types = e.dataTransfer.types;
      if (types.includes(ENTRY_DRAG_TYPE)) {
        if (!canDropInto(folderId, dirRel)) return null;
        return e.altKey || (dragging.current && dragging.current.folderId !== folderId) ? 'copy' : 'move';
      }
      if (types.includes('Files')) return 'copy';
      return null;
    };
    return {
      onDragOver: (e: DragEvent) => {
        const effect = accepts(e);
        if (!effect) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = effect;
        if (dropKey !== key) setDropKey(key);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropKey((k) => (k === key ? null : k));
      },
      onDrop: (e: DragEvent) => {
        const effect = accepts(e);
        setDropKey(null);
        if (!effect) return;
        e.preventDefault();
        e.stopPropagation();
        const raw = e.dataTransfer.getData(ENTRY_DRAG_TYPE);
        if (raw) {
          dragging.current = null;
          try {
            const doc = JSON.parse(raw) as { folderId?: unknown; relPath?: unknown };
            const src = typeof doc.folderId === 'string' && typeof doc.relPath === 'string' ? doc : null;
            const listing = src ? findKind(listings, src.folderId as string, src.relPath as string) : null;
            if (src && listing) {
              transfer(effect, { folderId: src.folderId as string, relPath: src.relPath as string, kind: listing }, { folderId, dirRel });
            }
          } catch {
            // A malformed in-app payload is ignored.
          }
          return;
        }
        importFiles(folderId, dirRel, e.dataTransfer.files);
      },
    };
  };

  // ── Rendering ──

  /** The props every row shares: selection, menu, keyboard focus, drag, drop. */
  const rowProps = (target: Target, onActivate: () => void) => ({
    'aria-selected': sameTarget(selected, target) || (target.kind === 'file' && sameTarget(selectedFile, target)),
    tabIndex: sameTarget(selected, target) || (!selected && target.relPath === '') ? 0 : -1,
    onClick: () => {
      setSelected(target);
      onActivate();
    },
    onContextMenu: (e: ReactMouseEvent) => openMenu(e, target),
    draggable: target.relPath !== '' && !editing,
    onDragStart: (e: DragEvent) => onDragStart(e, target),
    onDragEnd,
    ...dropHandlers(target),
  });

  const rowBackground = (target: Target): string => {
    const dirKey = target.kind === 'dir' ? listingKey(target.folderId, target.relPath) : null;
    if (dirKey && dropKey === dirKey) return token('surfaceHover');
    if (sameTarget(selected, target) || (target.kind === 'file' && sameTarget(selectedFile, target))) return token('surfaceHover');
    return 'transparent';
  };

  const rowExtraStyle = (target: Target): CSSProperties => {
    const dirKey = target.kind === 'dir' ? listingKey(target.folderId, target.relPath) : null;
    const isDrop = dirKey !== null && dropKey === dirKey;
    const isCut = clip?.cut === true && sameTarget(clip, target);
    const isSelected = sameTarget(selected, target);
    return {
      background: rowBackground(target),
      boxShadow: isDrop ? `inset 0 0 0 1px ${token('accent')}` : undefined,
      opacity: isCut ? disabledOpacity : 1,
      color: isSelected || (target.kind === 'file' && sameTarget(selectedFile, target)) ? token('text') : undefined,
    };
  };

  const nameInput = (initial: string, kind: 'file' | 'dir', depth: number): ReactNode => (
    <div style={{ ...rowStyle(depth), cursor: 'default' }}>
      <span aria-hidden style={{ width: 12, flexShrink: 0 }} />
      {kind === 'dir' ? <FolderIcon size={14} /> : <FileIcon size={14} />}
      <NameInput
        initial={initial}
        kind={kind}
        label={kind === 'dir' ? t('workbench.explorer.folderName') : t('workbench.explorer.fileName')}
        onCommit={commitEdit}
        onCancel={() => {
          setEditing(null);
          treeRef.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus();
        }}
      />
    </div>
  );

  const renderDir = (folder: FolderView, relPath: string, depth: number): ReactNode => {
    const entry = listings[listingKey(folder.id, relPath)];
    const pending =
      editing?.mode === 'new' && editing.folderId === folder.id && editing.dirRel === relPath
        ? nameInput('', editing.kind, depth)
        : null;
    if (!entry || entry.state === 'loading') {
      return <p style={{ ...mutedTextStyle, ...indentStyle(depth) }}>{t('workbench.explorer.loading')}</p>;
    }
    if (entry.state === 'error') {
      return <p style={{ ...mutedTextStyle, ...indentStyle(depth), color: token('danger') }}>{t('workbench.explorer.error')}</p>;
    }
    const { entries, truncated } = entry.listing;
    if (entries.length === 0 && !pending) {
      return <p style={{ ...mutedTextStyle, ...indentStyle(depth) }}>{t('workbench.explorer.emptyDir')}</p>;
    }
    return (
      <div role="group">
        {pending}
        {entries.map((e) => {
          const child = joinRel(relPath, e.name);
          const target: Target = { folderId: folder.id, relPath: child, kind: e.kind };
          const renaming = editing?.mode === 'rename' && sameTarget(editing, target);
          if (e.kind === 'file') {
            if (renaming) return <div key={e.name}>{nameInput(e.name, 'file', depth)}</div>;
            return (
              <button
                key={e.name}
                type="button"
                role="treeitem"
                aria-level={depth + 1}
                title={`${folder.name}/${child}`}
                {...rowProps(target, () => onOpenFile(folder, child))}
                {...hoverBackground(rowBackground(target), token('surfaceHover'))}
                style={{ ...rowStyle(depth), ...rowExtraStyle(target) }}
              >
                <span aria-hidden style={{ width: 12, flexShrink: 0 }} />
                <FileIcon size={14} />
                <span style={ellipsisStyle}>{e.name}</span>
              </button>
            );
          }
          const key = listingKey(folder.id, child);
          const isOpen = Boolean(open[key]);
          // The tree stops where the path limits do (main would refuse anything deeper).
          const atLimit = depth >= WORKBENCH_LIMITS.folderRelDepth || child.length >= WORKBENCH_LIMITS.folderRelPath;
          return (
            <div key={e.name} role="none">
              {renaming ? (
                nameInput(e.name, 'dir', depth)
              ) : (
                <button
                  type="button"
                  role="treeitem"
                  aria-expanded={isOpen}
                  aria-level={depth + 1}
                  disabled={atLimit}
                  {...rowProps(target, () => toggle(folder.id, child))}
                  {...hoverBackground(rowBackground(target), token('surfaceHover'))}
                  style={{ ...rowStyle(depth), ...rowExtraStyle(target), ...(atLimit ? { opacity: disabledOpacity } : null) }}
                >
                  <ChevronIcon open={isOpen} />
                  <FolderIcon size={14} open={isOpen} />
                  <span style={ellipsisStyle}>{e.name}</span>
                </button>
              )}
              {isOpen && renderDir(folder, child, depth + 1)}
            </div>
          );
        })}
        {truncated && (
          <p style={{ ...mutedTextStyle, ...indentStyle(depth), fontSize: fontSize.xs }}>
            {t('workbench.explorer.truncated').replace('{{count}}', String(WORKBENCH_LIMITS.folderEntries))}
          </p>
        )}
      </div>
    );
  };

  if (collapsed) {
    return (
      <aside aria-label={t('workbench.explorer.title')} style={{ ...railStyle, borderLeft: `1px solid ${token('border')}` }}>
        <IconButton label={t('workbench.explorer.expand')} onClick={onToggleCollapsed} expanded={false}>
          <PanelIcon side="right" />
        </IconButton>
        <IconButton label={t('workbench.explorer.expand')} onClick={onToggleCollapsed}>
          <FolderIcon />
        </IconButton>
      </aside>
    );
  }

  return (
    <aside aria-label={t('workbench.explorer.title')} style={panelStyle}>
      <div style={headerStyle}>
        <h2 style={titleStyle}>{t('workbench.explorer.title')}</h2>
        <IconButton label={t('workbench.explorer.refresh')} onClick={refresh} disabled={folders.length === 0}>
          <RefreshIcon size={14} />
        </IconButton>
        <IconButton label={t('workbench.folders.add')} onClick={() => void run(addFolder)} disabled={full}>
          <PlusIcon />
        </IconButton>
        <IconButton label={t('workbench.explorer.collapse')} onClick={onToggleCollapsed} expanded>
          <PanelIcon side="right" />
        </IconButton>
      </div>
      <div
        ref={treeRef}
        role="tree"
        aria-label={t('workbench.explorer.title')}
        onKeyDown={onTreeKeyDown}
        // A drop that misses every row must not reach the window (it would try to navigate).
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'none';
          }
        }}
        onDrop={(e) => e.preventDefault()}
        style={treeStyle}
      >
        {folders.length === 0 ? (
          <div style={{ padding: space.lg, display: 'flex', flexDirection: 'column', gap: space.md, alignItems: 'flex-start' }}>
            <p style={mutedTextStyle}>{t('workbench.folders.empty')}</p>
            <button
              type="button"
              onClick={() => void run(addFolder)}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={ghostButtonStyle}
            >
              {t('workbench.folders.add')}
            </button>
          </div>
        ) : (
          folders.map((folder) => {
            const key = listingKey(folder.id, '');
            const isOpen = Boolean(open[key]);
            const target: Target = { folderId: folder.id, relPath: '', kind: 'dir' };
            return (
              <div key={folder.id} role="none">
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <button
                    type="button"
                    role="treeitem"
                    aria-expanded={isOpen}
                    aria-level={1}
                    title={folder.displayPath}
                    {...rowProps(target, () => toggle(folder.id, ''))}
                    {...hoverBackground(rowBackground(target), token('surfaceHover'))}
                    style={{ ...rowStyle(0), fontWeight: 600, color: token('text'), ...rowExtraStyle(target) }}
                  >
                    <ChevronIcon open={isOpen} />
                    <span style={ellipsisStyle}>{folder.name}</span>
                    {folder.isGitRepo && <span style={badgeStyle}>{t('workbench.folders.git')}</span>}
                  </button>
                  <IconButton
                    label={`${t('workbench.folders.remove')}: ${folder.name}`}
                    onClick={() => setConfirmRemove(folder)}
                    size={22}
                  >
                    <CloseIcon />
                  </IconButton>
                </div>
                {isOpen && renderDir(folder, '', 1)}
              </div>
            );
          })
        )}
      </div>
      {folders.length > 0 && <p style={{ ...mutedTextStyle, padding: `${space.sm}px ${space.lg}px`, fontSize: fontSize.xs }}>{t('workbench.explorer.hint')}</p>}
      {menu && (
        <ExplorerContextMenu x={menu.x} y={menu.y} label={t('workbench.explorer.menu')} items={menuItems(menu.target)} onClose={closeMenu} />
      )}
      {confirmTrash && (
        <ConfirmDialog
          title={t('workbench.explorer.trashConfirm').replace('{{name}}', baseName(confirmTrash.relPath))}
          message={t('workbench.explorer.trashHint')}
          confirmLabel={t('workbench.explorer.trash')}
          cancelLabel={t('workbench.cancel')}
          danger
          onConfirm={() => {
            const target = confirmTrash;
            setConfirmTrash(null);
            trash(target);
          }}
          onCancel={() => setConfirmTrash(null)}
        />
      )}
      {confirmRemove && (
        <ConfirmDialog
          title={t('workbench.explorer.removeConfirm')}
          message={confirmRemove.displayPath}
          confirmLabel={t('workbench.folders.remove')}
          cancelLabel={t('workbench.cancel')}
          danger
          onConfirm={() => {
            const id = confirmRemove.id;
            setConfirmRemove(null);
            void run(() => removeFolder(id));
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </aside>
  );
}

/** The kind of a listed entry (a drop only moves what the tree has shown). */
function findKind(listings: Record<string, Listing>, folderId: string, relPath: string): 'file' | 'dir' | null {
  if (relPath === '') return null;
  const entry = listings[listingKey(folderId, parentRel(relPath))];
  if (entry?.state !== 'ready') return null;
  return entry.listing.entries.find((e) => e.name === baseName(relPath))?.kind ?? null;
}

/** Inline name field for rename / new entry: Enter or blur commits, Escape cancels. */
function NameInput({
  initial,
  kind,
  label,
  onCommit,
  onCancel,
}: {
  initial: string;
  kind: 'file' | 'dir';
  label: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the name without its extension, as editors do.
    const dot = kind === 'file' ? initial.lastIndexOf('.') : -1;
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial, kind]);
  const finish = (commit: boolean): void => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(ref.current?.value ?? '');
    else onCancel();
  };
  return (
    <input
      ref={ref}
      aria-label={label}
      defaultValue={initial}
      maxLength={255}
      spellCheck={false}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      style={nameInputStyle}
    />
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const INDENT = 12;
const indentStyle = (depth: number): CSSProperties => ({ padding: `3px 8px 3px ${8 + depth * INDENT + 16}px` });

const panelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const railStyle: CSSProperties = {
  flex: 1,
  width: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: space.xs,
  padding: `${space.sm}px 0`,
  boxSizing: 'border-box',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  padding: `${space.sm}px ${space.sm}px ${space.xs}px ${space.lg}px`,
  flexShrink: 0,
};

const titleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  margin: 0,
  fontSize: fontSize.sm,
  fontWeight: 600,
  color: token('textMuted'),
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const treeStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  padding: `${space.xs}px ${space.sm}px`,
};

function rowStyle(depth: number): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    width: '100%',
    boxSizing: 'border-box',
    height: 24,
    padding: `0 8px 0 ${4 + depth * INDENT}px`,
    border: 'none',
    borderRadius: radius.sm,
    background: 'transparent',
    color: token('textMuted'),
    fontSize: fontSize.base,
    textAlign: 'left',
    cursor: 'pointer',
  };
}

const nameInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 20,
  boxSizing: 'border-box',
  padding: '0 4px',
  border: `1px solid ${token('focusRing')}`,
  borderRadius: radius.sm,
  background: token('bg'),
  color: token('text'),
  fontSize: fontSize.base,
  outline: 'none',
};

const ellipsisStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const badgeStyle: CSSProperties = {
  flexShrink: 0,
  fontSize: fontSize.xs,
  fontWeight: 400,
  color: token('textMuted'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.pill,
  padding: '0 6px',
};

const mutedTextStyle: CSSProperties = { margin: 0, fontSize: fontSize.sm, color: token('textMuted') };

const ghostButtonStyle: CSSProperties = {
  padding: '4px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
};
