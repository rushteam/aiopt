// Shared Workbench chat shell — coordinator and task workers use the same composer + bubbles.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useEffect,
  useRef,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { disabledOpacity, elevation, token, fontSize, radius, space } from '../../themes/tokens';
import { useMentionPicker, type MentionSource } from './mentionPicker';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { VirtualChatList } from '../../components/ui/VirtualChatList';
import { estimateTextHeight } from '../../lib/virtualList';
import { CHAT_IMAGE_TYPES } from '../../../shared/workbench';
import { imageFiles, imagePreviewUrl, type DraftImage } from './chatImageAttach';
import {
  collapsedHead,
  DraftBlocks,
  insertAt,
  isLargePaste,
  normalizePaste,
  repairMarkers,
  snapSelection,
  splitFences,
} from './draftBlocks';
import {
  codeSource,
  findPathRefs,
  parseFileRef,
  type FileRefTarget,
  type PathRefMatch,
  type RefFolder,
} from './fileRefs';
import { hasEntryDrag, readEntryDrag, type DraggedEntry } from './entryDrag';
import { MarkdownView, type MarkdownRenderers } from './MarkdownView';
import { isDocumentReply } from './markdown';

/**
 * What chat messages can open: a file reference opens the file preview (at its lines), a code
 * block without a source opens a temporary read-only view. Absent, messages render no links.
 */
export interface ChatLinks {
  folders: readonly RefFolder[];
  openFile: (target: FileRefTarget) => void;
  openSnippet: (snippet: { text: string; lang: string }) => void;
  /** Whether a plain path's file exists (undefined: not known yet); see `fileProbe.ts`. */
  fileExists: (target: FileRefTarget) => boolean | undefined;
  probe: (targets: readonly FileRefTarget[]) => void;
}

export const ChatLinksContext = createContext<ChatLinks | null>(null);

/** `text` with its resolvable file references as links; the rest goes through `render`. */
export function LinkedText({ text, render = (s) => s }: { text: string; render?: (text: string) => ReactNode }) {
  const links = useContext(ChatLinksContext);
  const folders = links?.folders;
  const candidates = useMemo<PathRefMatch[]>(() => (folders ? findPathRefs(text, folders) : []), [text, folders]);
  const probe = links?.probe;
  useEffect(() => {
    const plain = candidates.filter((c) => !c.explicit).flatMap((c) => c.targets);
    if (probe && plain.length > 0) probe(plain);
  }, [candidates, probe]);
  if (!links || candidates.length === 0) return <>{render(text)}</>;
  // A plain path links to the first of its candidates that exists.
  const refs: (FileRefTarget & { index: number; length: number })[] = [];
  for (const c of candidates) {
    const target = c.explicit ? c.targets[0] : c.targets.find((t) => links.fileExists(t) === true);
    if (target) refs.push({ ...target, index: c.index, length: c.length });
  }
  if (refs.length === 0) return <>{render(text)}</>;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const ref of refs) {
    if (ref.index > last) parts.push(<span key={`t${last}`}>{render(text.slice(last, ref.index))}</span>);
    const label = text.slice(ref.index, ref.index + ref.length);
    parts.push(
      <button
        key={`r${ref.index}`}
        type="button"
        title={label}
        onClick={() => {
          const { folderId, relPath, range } = ref;
          links.openFile(range ? { folderId, relPath, range } : { folderId, relPath });
        }}
        style={refLinkStyle}
      >
        {label}
      </button>,
    );
    last = ref.index + ref.length;
  }
  if (last < text.length) parts.push(<span key={`t${last}`}>{render(text.slice(last))}</span>);
  return <>{parts}</>;
}

/** A Markdown link to a local path: a link to the file when it resolves, plain text otherwise. */
function ChatLocalLink({ href, children }: { href: string; children: ReactNode }) {
  const links = useContext(ChatLinksContext);
  const folders = links?.folders;
  const match = useMemo(() => {
    if (!folders) return null;
    const target = href.trim();
    return findPathRefs(target, folders).find((c) => c.index === 0 && c.length === target.length) ?? null;
  }, [href, folders]);
  const probe = links?.probe;
  useEffect(() => {
    if (probe && match && !match.explicit) probe(match.targets);
  }, [match, probe]);
  const target =
    !links || !match
      ? undefined
      : match.explicit
        ? match.targets[0]
        : match.targets.find((t) => links.fileExists(t) === true);
  if (!links || !target) return <span title={href}>{children}</span>;
  return (
    <button
      type="button"
      title={href}
      onClick={() => {
        const { folderId, relPath, range } = target;
        links.openFile(range ? { folderId, relPath, range } : { folderId, relPath });
      }}
      style={refLinkStyle}
    >
      {children}
    </button>
  );
}

/** How Markdown from a chat reply links: paths open their files, code blocks show like chat's. */
export function useChatMarkdownRenderers(t: TranslateFn): MarkdownRenderers {
  const links = useContext(ChatLinksContext);
  return useMemo<MarkdownRenderers>(
    () => ({
      text: (s) => <LinkedText text={s} />,
      localLink: (href, children) => <ChatLocalLink href={href}>{children}</ChatLocalLink>,
      codeBlock: ({ lang, text }) => (
        <CollapsibleBlock
          text={text}
          code={{
            lang,
            open: links
              ? { label: t('workbench.chat.openSnippet'), run: () => links.openSnippet({ text, lang }) }
              : undefined,
          }}
          maxLines={COLLAPSE_CODE_LINES}
          t={t}
          render={(s) => s}
        />
      ),
    }),
    [links, t],
  );
}

/**
 * A coordinator reply rendered as Markdown. Paths in it link to their files, code blocks show
 * like the user's (collapsible, openable), and a finished long reply can open as a document.
 */
export function AssistantMarkdown({ text, t, done }: { text: string; t: TranslateFn; done: boolean }) {
  const links = useContext(ChatLinksContext);
  const renderers = useChatMarkdownRenderers(t);
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: space.sm, maxWidth: '100%' }}
    >
      <div style={{ maxWidth: '100%', minWidth: 0, alignSelf: 'stretch' }}>
        <MarkdownView text={text} imageLabel={t('workbench.explorer.image')} variant="chat" renderers={renderers} />
      </div>
      {done && links && isDocumentReply(text) && (
        <button
          type="button"
          onClick={() => links.openSnippet({ text, lang: 'markdown' })}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={openDocumentStyle}
        >
          {t('workbench.chat.openAsDocument')}
        </button>
      )}
    </div>
  );
}

const openDocumentStyle: CSSProperties = {
  padding: '2px 8px',
  marginLeft: -8,
  border: 'none',
  borderRadius: radius.sm,
  background: 'transparent',
  color: token('textMuted'),
  font: 'inherit',
  fontSize: fontSize.sm,
  cursor: 'pointer',
};

const refLinkStyle: CSSProperties = {
  display: 'inline',
  padding: 0,
  margin: 0,
  border: 'none',
  background: 'transparent',
  color: token('accent'),
  font: 'inherit',
  textAlign: 'left',
  textDecoration: 'underline',
  textDecorationStyle: 'dotted',
  textUnderlineOffset: 3,
  cursor: 'pointer',
  whiteSpace: 'inherit',
  overflowWrap: 'anywhere',
};

export type WorkbenchChatLineRole = 'user' | 'assistant' | 'notice';

export interface WorkbenchChatLine {
  id: string;
  role: WorkbenchChatLineRole;
  text: string;
}

/** Widest a transcript / composer column grows: long lines past ~75 characters read poorly. */
export const CHAT_COLUMN_MAX_WIDTH = 760;

/** Centers chat content in a readable column, however wide the pane is. */
export function ChatColumn({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        width: '100%',
        maxWidth: CHAT_COLUMN_MAX_WIDTH,
        marginLeft: 'auto',
        marginRight: 'auto',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** The user's turn: a soft right-aligned bubble that fits its text. */
export function UserBubble({ children, t }: { children: ReactNode; t: TranslateFn }) {
  return (
    <div style={{ alignSelf: 'flex-end', maxWidth: '85%' }}>
      <span className="sr-only">{t('workbench.chat.you')}</span>
      <div style={userBubbleStyle}>{children}</div>
    </div>
  );
}

/** An agent's reply text: no bubble, roomy line-height, selectable. */
export const assistantTextStyle: CSSProperties = {
  fontSize: fontSize.md,
  lineHeight: 1.65,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  maxWidth: '100%',
  userSelect: 'text',
};

/**
 * "Working" indicator: a 3×3 pixel grid that ripples, the label, and the seconds since it
 * appeared. The ripple is decoration (global.css stops it under reduced motion); the label is
 * the status a screen reader hears.
 */
export function ChatLoadingIndicator({ label }: { label: string }) {
  const elapsed = useElapsedLabel();
  return (
    <div role="status" aria-label={label} style={{ display: 'flex', alignItems: 'center', gap: space.md, minHeight: 20 }}>
      <span aria-hidden className="aiopt-pixel-loader">
        {PIXEL_DELAYS.map((delay, i) => (
          <span key={i} style={{ animationDelay: `${delay}ms` }} />
        ))}
      </span>
      <span style={{ fontSize: fontSize.base, fontWeight: 500, color: token('textMuted') }}>{label}</span>
      <span aria-hidden style={{ fontSize: fontSize.sm, color: token('textMuted'), fontVariantNumeric: 'tabular-nums' }}>
        {elapsed}
      </span>
    </div>
  );
}

// A chevron sweep across the grid: each cell's delay grows with its column and its distance
// from the middle row.
const PIXEL_DELAYS = Array.from({ length: 9 }, (_, i) => ((i % 3) + Math.abs(Math.floor(i / 3) - 1)) * 90);

function useElapsedLabel(): string {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = (now - startedAt) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

export function WorkbenchChatBubble({ line, t }: { line: WorkbenchChatLine; t: TranslateFn }) {
  if (line.role === 'notice') {
    return (
      <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted'), whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {line.text}
      </p>
    );
  }
  if (line.role === 'user')
    return (
      <UserBubble t={t}>
        <UserMessageBody text={line.text} t={t} />
      </UserBubble>
    );
  return (
    <div style={assistantTextStyle}>
      <LinkedText text={line.text} />
    </div>
  );
}

const userBubbleStyle: CSSProperties = {
  padding: '8px 14px',
  borderRadius: radius['2xl'],
  background: token('surfaceHover'),
  fontSize: fontSize.md,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  userSelect: 'text',
};

/** Plain text in a bubble past this many lines (or characters) is shown collapsed. */
const COLLAPSE_TEXT_LINES = 16;
const COLLAPSE_TEXT_CHARS = 1600;
/** Code in a bubble past this many lines is shown collapsed. */
const COLLAPSE_CODE_LINES = 12;

/** Roughly the text a user bubble shows before anything is expanded, for row-height estimates. */
export function collapsedUserText(text: string): string {
  return splitFences(text)
    .map((seg) => {
      const code = seg.kind === 'code';
      const max = code ? COLLAPSE_CODE_LINES : COLLAPSE_TEXT_LINES;
      const cut = collapsedHead(seg.text, max, code ? max * 200 : COLLAPSE_TEXT_CHARS);
      return cut ? `${cut.head}\n` : seg.text;
    })
    .join('\n\n');
}

/**
 * A user message's text in its bubble. Fenced code (a quoted line range, pasted code) shows as
 * a code block; a long block, code or text, opens collapsed with a toggle. The message itself
 * is unchanged: this only decides how much of it is on screen.
 */
export function UserMessageBody({
  text,
  t,
  renderText = (s) => s,
}: {
  text: string;
  t: TranslateFn;
  /** Renders a plain-text run (e.g. to turn @task tokens into chips). */
  renderText?: (text: string) => ReactNode;
}) {
  const links = useContext(ChatLinksContext);
  const segments = splitFences(text);
  const linked = (s: string): ReactNode => <LinkedText text={s} render={renderText} />;
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          return <CollapsibleBlock key={i} text={seg.text} maxLines={COLLAPSE_TEXT_LINES} t={t} render={linked} />;
        }
        const source = links ? codeSource(segments, i, links.folders) : null;
        const open = !links
          ? undefined
          : source
            ? { label: t('workbench.chat.openInFile'), run: () => links.openFile(source) }
            : { label: t('workbench.chat.openSnippet'), run: () => links.openSnippet({ text: seg.text, lang: seg.lang }) };
        return (
          <CollapsibleBlock
            key={i}
            text={seg.text}
            code={{ lang: seg.lang, open }}
            maxLines={COLLAPSE_CODE_LINES}
            t={t}
            render={(s) => s}
          />
        );
      })}
    </>
  );
}

function CollapsibleBlock({
  text,
  code,
  maxLines,
  t,
  render,
}: {
  text: string;
  /** Set for a code block: its language and what its header button opens. */
  code?: { lang: string; open?: { label: string; run: () => void } };
  maxLines: number;
  t: TranslateFn;
  render: (text: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const cut = collapsedHead(text, maxLines, code ? maxLines * 200 : COLLAPSE_TEXT_CHARS);
  const shown = cut && !open ? cut.head : text;
  const body = code ? (
    <div style={codeFrameStyle}>
      {(code.lang || code.open) && (
        <div style={codeHeaderStyle}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{code.lang}</span>
          {code.open && (
            <button
              type="button"
              onClick={code.open.run}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={codeOpenButtonStyle}
            >
              {code.open.label}
            </button>
          )}
        </div>
      )}
      <pre style={bubbleCodeStyle}>
        <code>{shown}</code>
      </pre>
    </div>
  ) : (
    <div style={{ whiteSpace: 'pre-wrap' }}>{render(shown)}</div>
  );
  if (!cut) return body;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      <div style={open ? undefined : collapsedFadeStyle}>{body}</div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        {...hoverBackground('transparent', token('surface'))}
        style={expandButtonStyle}
      >
        {open ? t('workbench.chat.showLess') : t('workbench.chat.showAll').replace('{{lines}}', String(cut.lines))}
      </button>
    </div>
  );
}

const codeFrameStyle: CSSProperties = {
  margin: `${space.xs}px 0`,
  maxWidth: '100%',
  background: token('bg'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.md,
  overflow: 'hidden',
};

const codeHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.sm,
  padding: `2px ${space.xs}px 2px ${space.md}px`,
  borderBottom: `1px solid ${token('border')}`,
  fontSize: fontSize.xs,
  color: token('textMuted'),
  whiteSpace: 'nowrap',
};

const codeOpenButtonStyle: CSSProperties = {
  flexShrink: 0,
  padding: '1px 8px',
  border: 'none',
  borderRadius: radius.sm,
  background: 'transparent',
  color: token('accent'),
  fontSize: fontSize.xs,
  cursor: 'pointer',
};

const bubbleCodeStyle: CSSProperties = {
  margin: 0,
  padding: `${space.sm}px ${space.md}px`,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: fontSize.sm,
  lineHeight: 1.5,
  whiteSpace: 'pre',
  overflowX: 'auto',
  maxWidth: '100%',
  boxSizing: 'border-box',
};

const collapsedFadeStyle: CSSProperties = {
  maxWidth: '100%',
  WebkitMaskImage: 'linear-gradient(to bottom, black 70%, transparent)',
  maskImage: 'linear-gradient(to bottom, black 70%, transparent)',
};

const expandButtonStyle: CSSProperties = {
  marginTop: 2,
  padding: '2px 8px',
  marginLeft: -8,
  border: 'none',
  borderRadius: radius.sm,
  background: 'transparent',
  color: token('accent'),
  fontSize: fontSize.sm,
  cursor: 'pointer',
};

/** Long text held out of the composer field as markers (see draftBlocks.ts). */
export interface ComposerBlocks {
  store: DraftBlocks;
  /** The label inside a quote marker's brackets: the reference and how many lines it holds. */
  quoteLabel: (ref: string, excerpt: string) => string;
  /** The label inside a paste marker's brackets. */
  pasteLabel: (id: number, text: string) => string;
  /** Shown under the field while markers are in the draft. */
  heldHint: (count: number) => string;
  /** Shown when the draft, expanded, is over the length cap. */
  tooLong: string;
  /** File / directory references held as chips beside the field (`@folder/path` tokens). */
  refs: readonly string[];
  /** Holds a reference as a chip (once). */
  addRef: (token: string) => void;
  removeRef: (token: string) => void;
  /** The text to send: the held references, then the draft with its markers expanded. */
  compose: (draft: string) => string;
  /** Drops every held block and reference (after a send). */
  reset: () => void;
  /** Accessible name of a chip's remove button. */
  removeRefLabel: string;
}

/** Most references one draft holds as chips. */
export const DRAFT_REFS_MAX = 20;

/** A composer's held blocks with their localized labels; one per draft, kept across renders. */
export function useComposerBlocks(t: TranslateFn): ComposerBlocks {
  const [store] = useState(() => new DraftBlocks());
  const [refs, setRefs] = useState<readonly string[]>([]);
  return {
    store,
    refs,
    addRef: (token) =>
      setRefs((r) => (r.includes(token) || r.length >= DRAFT_REFS_MAX ? r : [...r, token])),
    removeRef: (token) => setRefs((r) => r.filter((x) => x !== token)),
    compose: (draft) => {
      const body = store.expand(draft).trim();
      const head = refs.join(' ');
      return head && body ? `${head}\n${body}` : head || body;
    },
    reset: () => {
      store.clear();
      setRefs([]);
    },
    removeRefLabel: t('workbench.chat.removeRef'),
    quoteLabel: (ref, text) =>
      t('workbench.chat.quoteLines').replace('{{ref}}', ref).replace('{{lines}}', String(text.split('\n').length)),
    pasteLabel: (id, text) => {
      const lines = text.split('\n').length;
      return lines > 1
        ? t('workbench.chat.pasteLines').replace('{{n}}', String(id)).replace('{{lines}}', String(lines))
        : t('workbench.chat.pasteChars').replace('{{n}}', String(id)).replace('{{chars}}', String(text.length));
    },
    heldHint: (count) => t('workbench.chat.blocksHeld').replace('{{count}}', String(count)),
    tooLong: t('workbench.chat.tooLong'),
  };
}

/** Centered empty-state copy for a transcript. */
export function ChatEmptyState({ title, body }: { title?: string; body: string }) {
  return (
    <div
      style={{
        margin: 'auto',
        maxWidth: 420,
        padding: space.xl,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: space.sm,
        textAlign: 'center',
      }}
    >
      {title && <p style={{ margin: 0, fontSize: fontSize.xl, fontWeight: 600, color: token('text') }}>{title}</p>}
      <p style={{ margin: 0, fontSize: fontSize.base, lineHeight: 1.6, color: token('textMuted') }}>{body}</p>
    </div>
  );
}

export function WorkbenchChatComposer({
  draft,
  setDraft,
  onSend,
  disabled,
  streaming,
  onAbort,
  maxLength,
  placeholder,
  sendHint,
  sendLabel,
  abortLabel,
  rows = 3,
  onTaskMentionDrop,
  dropHint,
  onEntryDrop,
  entryDropHint,
  mentions,
  attachments,
  blocks,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  streaming?: boolean;
  onAbort?: () => void;
  maxLength: number;
  placeholder: string;
  sendHint: string;
  sendLabel: string;
  abortLabel?: string;
  rows?: number;
  /** When set, accepts task tabs dragged from the task board. */
  onTaskMentionDrop?: (taskId: string) => void;
  dropHint?: string;
  /** When set, accepts files / directories dragged from the explorer (as `@folder/path`). */
  onEntryDrop?: (entry: DraggedEntry) => void;
  entryDropHint?: string;
  /** When set, typing `@` opens a picker over these options (tasks and sessions). */
  mentions?: MentionSource;
  /** When set, images can be pasted, dropped or picked and are shown above the field. */
  attachments?: ComposerAttachments;
  /** When set, a large paste goes into the field as a marker and is expanded when sent. */
  blocks?: ComposerBlocks;
}) {
  const [dropActive, setDropActive] = useState<false | 'task' | 'image' | 'entry'>(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const refMentions = useMemo(
    () => (mentions && blocks ? { ...mentions, onRef: blocks.addRef } : mentions),
    [mentions, blocks],
  );
  const picker = useMentionPicker({ mentions: refMentions, draft, setDraft, maxLength, disabled, textRef });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const takesImages = attachments !== undefined && !disabled;
  const onDragOver = (e: DragEvent): void => {
    if (onEntryDrop && !disabled && hasEntryDrag(e.dataTransfer)) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setDropActive('entry');
      return;
    }
    if (takesImages && e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDropActive('image');
      return;
    }
    if (!onTaskMentionDrop) return;
    if (e.dataTransfer.types.includes('application/x-aiopt-workbench-task')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDropActive('task');
    }
  };
  const onDragLeave = (): void => setDropActive(false);
  const onDrop = (e: DragEvent): void => {
    setDropActive(false);
    if (onEntryDrop && !disabled && hasEntryDrag(e.dataTransfer)) {
      e.preventDefault();
      e.stopPropagation();
      const entry = readEntryDrag(e.dataTransfer);
      if (entry) onEntryDrop(entry);
      textRef.current?.focus();
      return;
    }
    if (takesImages && e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      const files = imageFiles(e.dataTransfer.files);
      if (files.length > 0) attachments.onAdd(files);
      return;
    }
    if (!onTaskMentionDrop) return;
    e.preventDefault();
    try {
      const raw = e.dataTransfer.getData('application/x-aiopt-workbench-task');
      const doc = JSON.parse(raw) as { id?: string };
      if (typeof doc.id === 'string') onTaskMentionDrop(doc.id);
    } catch {
      // ignore bad payload
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (picker.onKeyDown(e)) return;
    // Backspace / Delete next to a marker removes the whole marker, as in pi's editor.
    if (blocks && (e.key === 'Backspace' || e.key === 'Delete') && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const el = e.currentTarget;
      if (el.selectionStart === el.selectionEnd) {
        const span = blocks.store.markerAt(draft, el.selectionStart, e.key === 'Backspace' ? 'before' : 'after');
        if (span) {
          e.preventDefault();
          setDraft(draft.slice(0, span.start) + draft.slice(span.end));
          requestAnimationFrame(() => el.setSelectionRange(span.start, span.start));
          return;
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSend();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (takesImages) {
      const files = imageFiles(e.clipboardData.files);
      if (files.length > 0) {
        // A copied file can come with its name as text too: take the image only.
        e.preventDefault();
        attachments.onAdd(files);
        return;
      }
    }
    if (!blocks) return;
    const pasted = e.clipboardData.getData('text/plain');
    if (!isLargePaste(pasted)) return;
    e.preventDefault();
    const text = normalizePaste(pasted);
    const el = e.currentTarget;
    const marker = blocks.store.add(text, blocks.pasteLabel(blocks.store.nextPasteId(), text));
    const next = insertAt(draft, el.selectionStart, el.selectionEnd, marker);
    if (next.text.length > maxLength) return;
    setDraft(next.text);
    requestAnimationFrame(() => el.setSelectionRange(next.caret, next.caret));
  };

  const held = blocks ? blocks.store.liveCount(draft) : 0;
  const heldRefs = blocks?.refs.length ?? 0;
  const tooLong = blocks !== undefined && held + heldRefs > 0 && blocks.compose(draft).length > maxLength;
  const hasImages = (attachments?.images.length ?? 0) > 0;
  const canSend = !disabled && (draft.trim() !== '' || heldRefs > 0 || hasImages) && !attachments?.reading && !tooLong;
  const [focused, setFocused] = useState(false);

  return (
    <div style={{ padding: `${space.xs}px ${space.lg}px ${space.lg}px` }}>
      <ChatColumn>
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={(e) => {
            // Clicking the card's padding focuses the field, like one big input.
            if (e.target === e.currentTarget) textRef.current?.focus();
          }}
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            gap: space.xs,
            padding: `${space.md}px ${space.md}px ${space.sm}px ${space.lg}px`,
            borderRadius: radius['2xl'],
            border: `1px solid ${dropActive || focused ? token('accent') : token('borderStrong')}`,
            background: token('surface'),
            boxShadow: elevation('composer'),
            opacity: disabled ? disabledOpacity : 1,
          }}
        >
          {picker.menu}
          {blocks && blocks.refs.length > 0 && <DraftRefStrip blocks={blocks} disabled={disabled} />}
          {attachments && (hasImages || attachments.error) && (
            <AttachmentStrip attachments={attachments} disabled={disabled} />
          )}
          <textarea
            ref={textRef}
            value={draft}
            onChange={(e) => {
              const el = e.target;
              // A marker is one unit: an edit that cuts into it removes it whole.
              const fixed = blocks ? repairMarkers(draft, el.value, blocks.store.spans(draft)) : null;
              if (!fixed) {
                setDraft(el.value);
                picker.sync(el);
                return;
              }
              setDraft(fixed.text);
              requestAnimationFrame(() => {
                el.setSelectionRange(fixed.caret, fixed.caret);
                picker.sync(el);
              });
            }}
            {...picker.textareaProps}
            onSelect={(e) => {
              const el = e.currentTarget;
              const snap = blocks ? snapSelection(el.selectionStart, el.selectionEnd, blocks.store.spans(el.value)) : null;
              if (snap) el.setSelectionRange(snap.start, snap.end);
              picker.textareaProps.onSelect?.(e);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              picker.textareaProps.onBlur?.();
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={disabled}
            maxLength={maxLength}
            rows={rows}
            placeholder={placeholder}
            aria-label={placeholder}
            className="aiopt-chat-input"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: `${space.xs}px 0`,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: token('text'),
              resize: 'none',
              fontFamily: 'inherit',
              fontSize: fontSize.md,
              lineHeight: 1.5,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: space.md, minHeight: 28 }}>
            <span
              role={tooLong ? 'alert' : undefined}
              style={{
                fontSize: fontSize.xs,
                color: tooLong ? token('danger') : token('textMuted'),
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {dropActive === 'entry' && entryDropHint
                ? entryDropHint
                : dropActive === 'image' && attachments
                  ? attachments.dropHint
                  : dropActive && dropHint
                    ? dropHint
                    : tooLong && blocks
                      ? blocks.tooLong
                      : held > 0 && blocks
                        ? blocks.heldHint(held)
                        : sendHint}
            </span>
            <span style={{ flex: 1 }} />
            {attachments && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={CHAT_IMAGE_TYPES.join(',')}
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = imageFiles(e.target.files);
                    e.target.value = '';
                    if (files.length > 0) attachments.onAdd(files);
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!takesImages}
                  aria-label={attachments.attachLabel}
                  title={attachments.attachLabel}
                  {...hoverBackground('transparent', token('surfaceHover'))}
                  style={{
                    ...roundButtonStyle,
                    background: 'transparent',
                    color: token('textMuted'),
                    cursor: takesImages ? 'pointer' : 'default',
                  }}
                >
                  <ImageGlyph />
                </button>
              </>
            )}
            {streaming && onAbort && abortLabel ? (
              <button
                type="button"
                onClick={onAbort}
                aria-label={abortLabel}
                title={abortLabel}
                {...hoverBackground(token('text'), token('textMuted'))}
                style={{ ...roundButtonStyle, background: token('text'), color: token('bg') }}
              >
                <span aria-hidden style={{ width: 10, height: 10, borderRadius: 2, background: 'currentColor' }} />
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!canSend}
                aria-label={sendLabel}
                title={sendLabel}
                {...hoverBackground(token('accent'), token('accentHover'))}
                style={{
                  ...roundButtonStyle,
                  background: token('accent'),
                  color: token('accentText'),
                  cursor: canSend ? 'pointer' : 'default',
                  opacity: canSend ? 1 : disabledOpacity,
                }}
              >
                <SendArrow />
              </button>
            )}
          </div>
        </div>
      </ChatColumn>
    </div>
  );
}

export interface ComposerAttachments {
  images: readonly DraftImage[];
  /** Images still being read (sending waits for them). */
  reading: boolean;
  /** A message about the last images that could not be attached, if any. */
  error: string | null;
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  attachLabel: string;
  removeLabel: string;
  imageLabel: string;
  dropHint: string;
}

/**
 * The references the draft holds (picked with `@`, dragged in, or inserted from the explorer),
 * as chips: click opens the file preview, × drops the reference. They go out ahead of the text.
 */
function DraftRefStrip({ blocks, disabled }: { blocks: ComposerBlocks; disabled: boolean }) {
  const links = useContext(ChatLinksContext);
  return (
    <ul style={refStripStyle}>
      {blocks.refs.map((token) => {
        const target = links ? parseFileRef(token, links.folders) : null;
        const plain = token.replace(/^`|`$/g, '');
        const name = plain.replace(/\/$/, '').split('/').pop() ?? plain;
        return (
          <li key={token} style={refChipStyle} title={plain}>
            <FileGlyph />
            {target && links ? (
              <button type="button" onClick={() => links.openFile(target)} style={refOpenStyle}>
                {name}
              </button>
            ) : (
              <span style={refNameStyle}>{name}</span>
            )}
            <button
              type="button"
              onClick={() => blocks.removeRef(token)}
              disabled={disabled}
              aria-label={`${blocks.removeRefLabel}: ${plain}`}
              style={refRemoveStyle}
            >
              <svg aria-hidden width="8" height="8" viewBox="0 0 8 8">
                <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function FileGlyph() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
      <path d="M3 1.5h4l2.5 2.5v6.5H3z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M7 1.5V4h2.5" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

const refStripStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: `${space.xs}px 0 0`,
  display: 'flex',
  flexWrap: 'wrap',
  gap: space.xs,
};

const refChipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: space.xs,
  maxWidth: 260,
  padding: `2px 2px 2px ${space.sm}px`,
  borderRadius: radius.md,
  border: `1px solid ${token('borderStrong')}`,
  background: token('bg'),
  color: token('textMuted'),
  fontSize: fontSize.xs,
};

const refNameStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: token('text'),
};

const refOpenStyle: CSSProperties = {
  ...refNameStyle,
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: token('accent'),
  font: 'inherit',
  cursor: 'pointer',
};

const refRemoveStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 18,
  height: 18,
  flexShrink: 0,
  padding: 0,
  border: 'none',
  borderRadius: radius.sm,
  background: 'transparent',
  color: token('textMuted'),
  cursor: 'pointer',
};

function AttachmentStrip({ attachments, disabled }: { attachments: ComposerAttachments; disabled: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs, paddingTop: space.xs }}>
      {attachments.images.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: space.sm }}>
          {attachments.images.map((image, index) => (
            <li key={image.id} style={{ position: 'relative' }}>
              <img
                src={imagePreviewUrl(image)}
                alt={attachments.imageLabel.replace('{{n}}', String(index + 1))}
                style={thumbStyle}
              />
              <button
                type="button"
                onClick={() => attachments.onRemove(image.id)}
                disabled={disabled}
                aria-label={attachments.removeLabel}
                title={attachments.removeLabel}
                style={thumbRemoveStyle}
              >
                <svg aria-hidden width="8" height="8" viewBox="0 0 8 8">
                  <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      {attachments.error && (
        <span role="alert" style={{ fontSize: fontSize.xs, color: token('danger') }}>
          {attachments.error}
        </span>
      )}
    </div>
  );
}

function ImageGlyph() {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6" cy="6.5" r="1.2" fill="currentColor" />
      <path d="M2.5 11.5l3.2-3 2.3 2.1 2-1.8 3.5 3" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

const thumbStyle: CSSProperties = {
  display: 'block',
  width: 56,
  height: 56,
  objectFit: 'cover',
  borderRadius: radius.md,
  border: `1px solid ${token('border')}`,
  background: token('bg'),
};

const thumbRemoveStyle: CSSProperties = {
  position: 'absolute',
  top: -6,
  right: -6,
  display: 'inline-grid',
  placeItems: 'center',
  width: 18,
  height: 18,
  padding: 0,
  borderRadius: radius.pill,
  border: `1px solid ${token('borderStrong')}`,
  background: token('surface'),
  color: token('text'),
  cursor: 'pointer',
};

function SendArrow() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function WorkbenchChatThread({
  lines,
  empty,
  t,
  footer,
}: {
  lines: WorkbenchChatLine[];
  empty: string;
  t: TranslateFn;
  footer?: ReactNode;
}) {
  const renderLine = useCallback(
    (line: WorkbenchChatLine) => (
      <ChatColumn>
        <WorkbenchChatBubble line={line} t={t} />
      </ChatColumn>
    ),
    [t],
  );
  return (
    <VirtualChatList
      items={lines}
      getKey={lineKey}
      renderItem={renderLine}
      estimateHeight={estimateLineHeight}
      footer={footer ? <ChatColumn>{footer}</ChatColumn> : undefined}
      gap={space.xl}
      padding={space.xl}
      jumpLabel={t('workbench.chat.jumpToLatest')}
      loadingLabel={t('workbench.chat.loadingOlder')}
      empty={<ChatEmptyState body={empty} />}
    />
  );
}

const lineKey = (line: WorkbenchChatLine): string => line.id;

function estimateLineHeight(line: WorkbenchChatLine, width: number): number {
  const text = line.role === 'user' ? collapsedUserText(line.text) : line.text;
  return estimateTextHeight(text, Math.max(20, Math.floor(width / 9)));
}

const roundButtonStyle: CSSProperties = {
  display: 'inline-grid',
  placeItems: 'center',
  width: 28,
  height: 28,
  padding: 0,
  borderRadius: radius.pill,
  border: 'none',
  cursor: 'pointer',
  flexShrink: 0,
};
