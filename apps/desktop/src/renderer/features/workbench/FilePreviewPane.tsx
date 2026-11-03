// A read-only preview of one file the explorer picked: plain text with line numbers, never
// rendered as HTML/Markdown and never executed. The bytes come from the named
// `workbench:folder-read` call (folder id + relative path; main confines, caps and refuses
// symlinks/hidden entries). Nothing of it is persisted on this side.
//
// The header can reference the file in the coordinator chat, or show it in the OS file manager
// (main resolves the path and only reveals it — it never opens or runs the file).

import { useEffect, useState, type CSSProperties } from 'react';
import { fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { readFolderFile, revealFolderEntry } from '../../lib/workbenchStore';
import { WORKBENCH_LIMITS, type FilePreview, type FolderView } from '../../../shared/workbench';
import { CloseIcon, FileIcon, RefreshIcon } from './workbenchIcons';
import { IconButton } from './workbenchPanes';
import { formatBytes, lineNumbers } from './workbenchNav';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

type State = { state: 'loading' } | { state: 'ready'; preview: FilePreview } | { state: 'error' };

export function FilePreviewPane({
  folder,
  relPath,
  t,
  run,
  onInsert,
  onClose,
}: {
  folder: FolderView;
  relPath: string;
  t: TranslateFn;
  run: Runner;
  onInsert: () => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ state: 'loading' });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ state: 'loading' });
    readFolderFile(folder.id, relPath).then(
      (preview) => live && setState({ state: 'ready', preview }),
      () => live && setState({ state: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [folder.id, relPath, reload]);

  const name = relPath.split('/').pop() ?? relPath;
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';

  return (
    <section aria-label={`${t('workbench.explorer.preview')}: ${name}`} style={paneStyle}>
      <div style={headerStyle}>
        <FileIcon size={14} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: space.sm }} title={`${folder.name}/${relPath}`}>
          <h2 style={titleStyle}>{name}</h2>
          <span style={pathStyle}>{dir ? `${folder.name}/${dir}` : folder.name}</span>
        </div>
        {state.state === 'ready' && <span style={metaStyle}>{formatBytes(state.preview.size)}</span>}
        <IconButton label={t('workbench.explorer.refresh')} onClick={() => setReload((n) => n + 1)} size={24}>
          <RefreshIcon size={14} />
        </IconButton>
        <button
          type="button"
          onClick={() => void run(() => revealFolderEntry(folder.id, relPath))}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={ghostButtonStyle}
        >
          {t('workbench.explorer.reveal')}
        </button>
        <button
          type="button"
          onClick={onInsert}
          {...hoverBackground(token('accent'), token('accentHover'))}
          style={primaryButtonStyle}
        >
          {t('workbench.explorer.insert')}
        </button>
        <IconButton label={t('workbench.explorer.closePreview')} onClick={onClose} size={24}>
          <CloseIcon />
        </IconButton>
      </div>
      {state.state === 'loading' ? (
        <p style={noticeStyle}>{t('workbench.explorer.loading')}</p>
      ) : state.state === 'error' ? (
        <p role="alert" style={{ ...noticeStyle, color: token('danger') }}>
          {t('workbench.explorer.previewError')}
        </p>
      ) : state.preview.binary ? (
        <p style={noticeStyle}>{t('workbench.explorer.binary')}</p>
      ) : (
        <>
          {state.preview.truncated && (
            <p style={bannerStyle}>
              {t('workbench.explorer.previewTruncated').replace('{{size}}', formatBytes(WORKBENCH_LIMITS.filePreviewBytes))}
            </p>
          )}
          {/* One scroller for gutter + text so the numbers stay aligned (lines never wrap). */}
          <div style={scrollStyle} tabIndex={0} aria-label={name}>
            <pre aria-hidden style={gutterStyle}>
              {lineNumbers(state.preview.text)}
            </pre>
            <pre style={codeStyle}>{state.preview.text}</pre>
          </div>
        </>
      )}
    </section>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const paneStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' };

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.sm,
  padding: '6px 8px 6px 12px',
  borderBottom: `1px solid ${token('border')}`,
  flexShrink: 0,
  color: token('textMuted'),
};

const titleStyle: CSSProperties = {
  margin: 0,
  flexShrink: 1,
  minWidth: 0,
  fontSize: fontSize.base,
  fontWeight: 600,
  color: token('text'),
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const pathStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: fontSize.xs,
  color: token('textMuted'),
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const metaStyle: CSSProperties = { flexShrink: 0, fontSize: fontSize.xs, color: token('textMuted') };

const ghostButtonStyle: CSSProperties = {
  flexShrink: 0,
  padding: '3px 10px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.xs,
  whiteSpace: 'nowrap',
};

const primaryButtonStyle: CSSProperties = {
  ...ghostButtonStyle,
  border: `1px solid transparent`,
  background: token('accent'),
  color: token('accentText'),
  fontWeight: 600,
};

const noticeStyle: CSSProperties = { margin: 0, padding: space.xl, fontSize: fontSize.sm, color: token('textMuted') };

const bannerStyle: CSSProperties = {
  margin: 0,
  padding: `${space.xs}px ${space.lg}px`,
  fontSize: fontSize.xs,
  color: token('textMuted'),
  background: token('surface'),
  borderBottom: `1px solid ${token('border')}`,
  flexShrink: 0,
};

const scrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  display: 'flex',
  alignItems: 'flex-start',
  outline: 'none',
};

const preBase: CSSProperties = {
  margin: 0,
  padding: `${space.md}px 0`,
  fontFamily: MONO,
  fontSize: fontSize.sm,
  lineHeight: 1.6,
  whiteSpace: 'pre',
};

const gutterStyle: CSSProperties = {
  ...preBase,
  position: 'sticky',
  left: 0,
  flexShrink: 0,
  minHeight: '100%',
  boxSizing: 'border-box',
  padding: `${space.md}px ${space.md}px ${space.md}px ${space.lg}px`,
  textAlign: 'right',
  color: token('textMuted'),
  background: token('bg'),
  borderRight: `1px solid ${token('border')}`,
  userSelect: 'none',
};

const codeStyle: CSSProperties = {
  ...preBase,
  flex: 1,
  padding: `${space.md}px ${space.lg}px`,
  color: token('text'),
  userSelect: 'text',
  tabSize: 2,
};
