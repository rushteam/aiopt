// The Workbench's right explorer: the folders granted to the workbench, each a lazily expanded
// file tree. Clicking a file opens its read-only preview in the content area (from which it can
// be referenced in the coordinator's composer or revealed in the OS file manager).
//
// Read-only and capability-free: every listing is the named `workbench:folder-list` call with
// the folder's opaque id and a relative path; main resolves it inside the granted folder,
// never follows a symlink, and caps the entries. Folders are added through main's own picker.
// Collapsed, it is a 40px rail with just the expand button.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { disabledOpacity, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { addFolder, listFolder, removeFolder } from '../../lib/workbenchStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { WORKBENCH_LIMITS, type FolderListing, type FolderView } from '../../../shared/workbench';
import { ChevronIcon, CloseIcon, FileIcon, FolderIcon, PanelIcon, PlusIcon, RefreshIcon } from './workbenchIcons';
import { IconButton } from './workbenchPanes';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

type Listing = { state: 'loading' } | { state: 'ready'; listing: FolderListing } | { state: 'error' };

const listingKey = (folderId: string, relPath: string): string => `${folderId}\u0000${relPath}`;

export function WorkbenchExplorer({
  folders,
  t,
  run,
  collapsed,
  onToggleCollapsed,
  onOpenFile,
  selectedFile,
}: {
  folders: readonly FolderView[];
  t: TranslateFn;
  run: Runner;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** A file was picked: preview it in the content area. */
  onOpenFile: (folder: FolderView, relPath: string) => void;
  /** The file being previewed, highlighted in the tree. */
  selectedFile: { folderId: string; relPath: string } | null;
}) {
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [confirmRemove, setConfirmRemove] = useState<FolderView | null>(null);
  const full = folders.length >= WORKBENCH_LIMITS.folders;
  // A late reply for a listing the user refreshed past is dropped.
  const generation = useRef(0);

  const load = useCallback((folderId: string, relPath: string) => {
    const key = listingKey(folderId, relPath);
    const gen = generation.current;
    setListings((m) => ({ ...m, [key]: { state: 'loading' } }));
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
      <div role="tree" aria-label={t('workbench.explorer.title')} style={treeStyle}>
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
            return (
              <div key={folder.id} role="none">
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <button
                    type="button"
                    role="treeitem"
                    aria-expanded={isOpen}
                    aria-level={1}
                    title={folder.displayPath}
                    onClick={() => toggle(folder.id, '')}
                    {...hoverBackground('transparent', token('surfaceHover'))}
                    style={{ ...rowStyle(0), fontWeight: 600, color: token('text') }}
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
                {isOpen && (
                  <DirChildren
                    folder={folder}
                    relPath=""
                    depth={1}
                    t={t}
                    listings={listings}
                    open={open}
                    onToggle={toggle}
                    onOpenFile={onOpenFile}
                    selectedFile={selectedFile}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
      {folders.length > 0 && <p style={{ ...mutedTextStyle, padding: `${space.sm}px ${space.lg}px`, fontSize: fontSize.xs }}>{t('workbench.explorer.hint')}</p>}
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

function DirChildren({
  folder,
  relPath,
  depth,
  t,
  listings,
  open,
  onToggle,
  onOpenFile,
  selectedFile,
}: {
  folder: FolderView;
  relPath: string;
  depth: number;
  t: TranslateFn;
  listings: Record<string, Listing>;
  open: Record<string, boolean>;
  onToggle: (folderId: string, relPath: string) => void;
  onOpenFile: (folder: FolderView, relPath: string) => void;
  selectedFile: { folderId: string; relPath: string } | null;
}) {
  const entry = listings[listingKey(folder.id, relPath)];
  if (!entry || entry.state === 'loading') {
    return <p style={{ ...mutedTextStyle, ...indentStyle(depth) }}>{t('workbench.explorer.loading')}</p>;
  }
  if (entry.state === 'error') {
    return <p style={{ ...mutedTextStyle, ...indentStyle(depth), color: token('danger') }}>{t('workbench.explorer.error')}</p>;
  }
  const { entries, truncated } = entry.listing;
  if (entries.length === 0) {
    return <p style={{ ...mutedTextStyle, ...indentStyle(depth) }}>{t('workbench.explorer.emptyDir')}</p>;
  }
  return (
    <div role="group">
      {entries.map((e) => {
        const child = relPath ? `${relPath}/${e.name}` : e.name;
        if (e.kind === 'file') {
          const selected = selectedFile?.folderId === folder.id && selectedFile.relPath === child;
          return (
            <button
              key={e.name}
              type="button"
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={selected}
              title={`${folder.name}/${child}`}
              onClick={() => onOpenFile(folder, child)}
              {...hoverBackground(selected ? token('surfaceHover') : 'transparent', token('surfaceHover'))}
              style={{ ...rowStyle(depth), ...(selected ? { background: token('surfaceHover'), color: token('text') } : null) }}
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
            <button
              type="button"
              role="treeitem"
              aria-expanded={isOpen}
              aria-level={depth + 1}
              disabled={atLimit}
              onClick={() => onToggle(folder.id, child)}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={{ ...rowStyle(depth), opacity: atLimit ? disabledOpacity : 1 }}
            >
              <ChevronIcon open={isOpen} />
              <FolderIcon size={14} open={isOpen} />
              <span style={ellipsisStyle}>{e.name}</span>
            </button>
            {isOpen && (
              <DirChildren
                folder={folder}
                relPath={child}
                depth={depth + 1}
                t={t}
                listings={listings}
                open={open}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                selectedFile={selectedFile}
              />
            )}
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
