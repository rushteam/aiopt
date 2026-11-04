// Shared Workbench chat shell — coordinator and task workers use the same composer + bubbles.

import {
  useCallback,
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
  if (line.role === 'user') return <UserBubble t={t}>{line.text}</UserBubble>;
  return <div style={assistantTextStyle}>{line.text}</div>;
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
  mentions,
  attachments,
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
  /** When set, typing `@` opens a picker over these options (tasks and sessions). */
  mentions?: MentionSource;
  /** When set, images can be pasted, dropped or picked and are shown above the field. */
  attachments?: ComposerAttachments;
}) {
  const [dropActive, setDropActive] = useState<false | 'task' | 'image'>(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const picker = useMentionPicker({ mentions, draft, setDraft, maxLength, disabled, textRef });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const takesImages = attachments !== undefined && !disabled;
  const onDragOver = (e: DragEvent): void => {
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
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSend();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!takesImages) return;
    const files = imageFiles(e.clipboardData.files);
    if (files.length === 0) return;
    // A copied file can come with its name as text too: take the image only.
    e.preventDefault();
    attachments.onAdd(files);
  };

  const hasImages = (attachments?.images.length ?? 0) > 0;
  const canSend = !disabled && (draft.trim() !== '' || hasImages) && !attachments?.reading;
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
          {attachments && (hasImages || attachments.error) && (
            <AttachmentStrip attachments={attachments} disabled={disabled} />
          )}
          <textarea
            ref={textRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              picker.sync(e.target);
            }}
            {...picker.textareaProps}
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
            <span style={{ fontSize: fontSize.xs, color: token('textMuted'), minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {dropActive === 'image' && attachments ? attachments.dropHint : dropActive && dropHint ? dropHint : sendHint}
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
  return estimateTextHeight(line.text, Math.max(20, Math.floor(width / 9)));
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
