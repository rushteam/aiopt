// A read-only preview of one file the explorer picked: plain text with line numbers, never
// rendered as HTML and never executed. A Markdown file also has a rendered view (MarkdownView
// builds React elements from a parsed tree, never HTML); a toggle switches it with the source. The bytes come from the named
// `workbench:folder-read` call (folder id + relative path; main confines, caps and refuses
// symlinks/hidden entries). Nothing of it is persisted on this side. While open (and the window
// visible) the file is re-read every couple of seconds, so a plan an agent is writing follows
// along; the rendered view has a table of contents, and its relative links open their files
// here (resolved inside the same folder, and main confines the read again).
//
// The header can reference the file in the coordinator chat, or show it in the OS file manager
// (main resolves the path and only reveals it — it never opens or runs the file). Lines can be
// picked — select text, or click / shift-click / drag the line numbers — and the reference
// then carries that line range and the picked lines as an excerpt. Opened from a chat
// reference that names lines (`focus`), the preview shows the source, picks them and scrolls
// them into view.

import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { readFolderFile, revealFolderEntry } from '../../lib/workbenchStore';
import { WORKBENCH_LIMITS, type FilePreview, type FolderView } from '../../../shared/workbench';
import { CloseIcon, FileIcon, RefreshIcon } from './workbenchIcons';
import { IconButton } from './workbenchPanes';
import { formatBytes, lineNumbers, sliceLines, type LineRange } from './workbenchNav';
import { isMarkdownPath, resolveRelativeHref } from './markdown';
import { MarkdownModeToggle, MarkdownView, type MarkdownRenderers } from './MarkdownView';
import { ChatLinksContext, LinkedText } from './workbenchChat';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

/** How often an open file is re-read to follow changes. */
const FOLLOW_INTERVAL_MS = 2000;

function samePreview(a: FilePreview, b: FilePreview): boolean {
  return a.size === b.size && a.binary === b.binary && a.truncated === b.truncated && a.text === b.text;
}

type State = { state: 'loading' } | { state: 'ready'; preview: FilePreview } | { state: 'error' };

export function FilePreviewPane({
  folder,
  relPath,
  t,
  run,
  focus,
  onInsert,
  onClose,
}: {
  folder: FolderView;
  relPath: string;
  /** Lines to show picked and scrolled into view once the file has loaded. */
  focus?: LineRange;
  t: TranslateFn;
  run: Runner;
  /** Reference the file; with `quote`, only the picked lines (and their text as an excerpt). */
  onInsert: (quote?: { range: LineRange; excerpt: string }) => void;
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

  // Follow the file while it is open: an agent writing a plan shows up as it goes. The poll
  // only runs while the window is visible, and an unchanged read changes nothing on screen.
  const loaded = state.state === 'ready';
  useEffect(() => {
    if (!loaded) return;
    let live = true;
    let busy = false;
    const poll = (): void => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      readFolderFile(folder.id, relPath).then(
        (next) => {
          busy = false;
          if (!live) return;
          setState((prev) =>
            prev.state === 'ready' && samePreview(prev.preview, next) ? prev : { state: 'ready', preview: next },
          );
        },
        () => {
          busy = false;
        },
      );
    };
    const timer = window.setInterval(poll, FOLLOW_INTERVAL_MS);
    window.addEventListener('focus', poll);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', poll);
    };
  }, [folder.id, relPath, reload, loaded]);

  const text = state.state === 'ready' && !state.preview.binary ? state.preview.text : '';
  const markdown = isMarkdownPath(relPath);
  // Markdown opens rendered; the choice holds while the pane stays open.
  const [mode, setMode] = useState<'rendered' | 'source'>(focus ? 'source' : 'rendered');
  const rendered = markdown && mode === 'rendered';
  const lineCount = text === '' ? 1 : lineNumbers(text).split('\n').length;
  const [range, setRange] = useState<LineRange | null>(null);
  useEffect(() => setRange(null), [folder.id, relPath, reload, mode]);
  const codeRef = useRef<HTMLPreElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<number | null>(null);

  // The focused lines are picked once, on the first load (a refresh or a mode switch clears them).
  const focusedRef = useRef(false);
  const ready = state.state === 'ready' && !state.preview.binary;
  useEffect(() => {
    if (!focus || !ready || focusedRef.current) return;
    focusedRef.current = true;
    const start = Math.min(Math.max(1, focus.start), lineCount);
    const end = Math.min(Math.max(start, focus.end), lineCount);
    setRange({ start, end });
    const scroller = scrollRef.current;
    const pre = codeRef.current;
    if (!scroller || !pre) return;
    const lineHeight = (pre.getBoundingClientRect().height - 2 * space.md) / lineCount;
    // The first focused line a third of the way down, so the lines above give context.
    scroller.scrollTop = Math.max(0, space.md + (start - 1) * lineHeight - scroller.clientHeight / 3);
  }, [focus, ready, lineCount]);

  // The line under a pointer, from the code block's measured line height (lines never wrap).
  const lineAt = (clientY: number): number => {
    const pre = codeRef.current;
    if (!pre) return 1;
    const rect = pre.getBoundingClientRect();
    const lineHeight = (rect.height - 2 * space.md) / lineCount;
    const line = Math.floor((clientY - rect.top - space.md) / lineHeight) + 1;
    return Math.min(lineCount, Math.max(1, line));
  };
  const pick = (a: number, b: number): void => setRange({ start: Math.min(a, b), end: Math.max(a, b) });

  const onGutterDown = (e: ReactPointerEvent<HTMLPreElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    const line = lineAt(e.clientY);
    const anchor = e.shiftKey && range ? (line < range.start ? range.end : range.start) : line;
    anchorRef.current = anchor;
    pick(anchor, line);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onGutterMove = (e: ReactPointerEvent<HTMLPreElement>): void => {
    if (anchorRef.current !== null && e.buttons & 1) pick(anchorRef.current, lineAt(e.clientY));
  };
  const onGutterUp = (): void => {
    anchorRef.current = null;
  };

  // A text selection inside the code picks the lines it touches; a plain click clears the pick.
  const onCodeUp = (): void => {
    const pre = codeRef.current;
    const sel = window.getSelection();
    if (!pre || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
      setRange(null);
      return;
    }
    const r = sel.getRangeAt(0);
    if (!pre.contains(r.startContainer) || !pre.contains(r.endContainer)) return;
    const offset = (node: Node, at: number): number => {
      const before = document.createRange();
      before.selectNodeContents(pre);
      before.setEnd(node, at);
      return before.toString().length;
    };
    const start = offset(r.startContainer, r.startOffset);
    let end = offset(r.endContainer, r.endOffset);
    // A selection ending right after a newline does not take the next line.
    if (end > start && text[end - 1] === '\n') end -= 1;
    const lineOf = (i: number): number => {
      let n = 1;
      for (let k = 0; k < i && k < text.length; k += 1) if (text.charCodeAt(k) === 10) n += 1;
      return Math.min(n, lineCount);
    };
    pick(lineOf(start), lineOf(end));
  };

  const insert = (): void => {
    if (!range) return onInsert();
    onInsert({ range, excerpt: sliceLines(text, range) });
    setRange(null);
    window.getSelection()?.removeAllRanges();
  };
  const rangeLabel = range ? (range.start === range.end ? `${range.start}` : `${range.start}–${range.end}`) : '';

  // Paths in the text link to their files; a relative link opens its file from this folder.
  const links = useContext(ChatLinksContext);
  const renderers = useMemo<MarkdownRenderers>(
    () => ({
      text: links ? (s) => <LinkedText text={s} /> : undefined,
      localLink: (href, children) => {
        const target = links ? resolveRelativeHref(relPath, href) : null;
        if (!links || !target) return <span title={href}>{children}</span>;
        return (
          <button
            type="button"
            title={href}
            onClick={() => links.openFile({ folderId: folder.id, relPath: target })}
            style={localLinkButtonStyle}
          >
            {children}
          </button>
        );
      },
    }),
    [links, folder.id, relPath],
  );

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
        {markdown && state.state === 'ready' && !state.preview.binary && (
          <MarkdownModeToggle mode={mode} onChange={setMode} t={t} />
        )}
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
          onClick={insert}
          title={range || rendered ? undefined : t('workbench.explorer.insertHint')}
          {...hoverBackground(token('accent'), token('accentHover'))}
          style={primaryButtonStyle}
        >
          {range
            ? t('workbench.explorer.insertLines').replace('{{lines}}', rangeLabel)
            : t('workbench.explorer.insert')}
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
          {rendered ? (
            <div style={renderedScrollStyle} tabIndex={0} aria-label={name}>
              <MarkdownView
                text={state.preview.text}
                imageLabel={t('workbench.explorer.image')}
                renderers={renderers}
                outlineLabel={t('workbench.explorer.outline')}
              />
            </div>
          ) : (
            <div
              ref={scrollRef}
              style={scrollStyle}
              tabIndex={0}
              aria-label={name}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && range) {
                  e.stopPropagation();
                  setRange(null);
                  window.getSelection()?.removeAllRanges();
                }
              }}
            >
              <pre
                aria-hidden
                style={gutterStyle}
                onPointerDown={onGutterDown}
                onPointerMove={onGutterMove}
                onPointerUp={onGutterUp}
                onPointerCancel={onGutterUp}
              >
                {lineNumbers(state.preview.text)}
              </pre>
              <div style={codeWrapStyle}>
                {range && (
                  <div
                    aria-hidden
                    style={{
                      ...pickStyle,
                      top: `calc(${space.md}px + ${range.start - 1} * ${LINE_HEIGHT}em)`,
                      height: `${(range.end - range.start + 1) * LINE_HEIGHT}em`,
                    }}
                  />
                )}
                <pre ref={codeRef} style={codeStyle} onMouseUp={onCodeUp}>
                  {state.preview.text}
                </pre>
              </div>
            </div>
          )}
          {range && (
            <p role="status" style={pickStatusStyle}>
              {t('workbench.explorer.linesPicked').replace('{{lines}}', rangeLabel)}
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
/** Line height in em, shared by the gutter, the code and the picked-lines band. */
const LINE_HEIGHT = 1.6;

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

const localLinkButtonStyle: CSSProperties = {
  display: 'inline',
  padding: 0,
  margin: 0,
  border: 'none',
  background: 'transparent',
  color: token('accent'),
  font: 'inherit',
  textAlign: 'left',
  textDecoration: 'underline',
  textUnderlineOffset: 2,
  cursor: 'pointer',
};

const renderedScrollStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', outline: 'none' };

const preBase: CSSProperties = {
  margin: 0,
  padding: `${space.md}px 0`,
  fontFamily: MONO,
  fontSize: fontSize.sm,
  lineHeight: LINE_HEIGHT,
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
  cursor: 'pointer',
};

const codeWrapStyle: CSSProperties = { position: 'relative', flex: 1, fontSize: fontSize.sm };

// The picked lines: a band behind the text (the code itself has no background), marked on the
// left edge so it reads in both themes without a dedicated token.
const pickStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  background: token('surfaceHover'),
  boxShadow: `inset 2px 0 0 ${token('accent')}`,
  pointerEvents: 'none',
};

const pickStatusStyle: CSSProperties = {
  margin: 0,
  padding: `${space.xs}px ${space.lg}px`,
  fontSize: fontSize.xs,
  color: token('textMuted'),
  background: token('surface'),
  borderTop: `1px solid ${token('border')}`,
  flexShrink: 0,
};

const codeStyle: CSSProperties = {
  ...preBase,
  position: 'relative',
  padding: `${space.md}px ${space.lg}px`,
  color: token('text'),
  userSelect: 'text',
  tabSize: 2,
};
