// Shared Workbench chat shell — coordinator and task workers use the same composer + bubbles.

import { useState, useEffect, useRef, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';

export type WorkbenchChatLineRole = 'user' | 'assistant' | 'notice';

export interface WorkbenchChatLine {
  id: string;
  role: WorkbenchChatLineRole;
  text: string;
}

export function WorkbenchChatBubble({ line, t }: { line: WorkbenchChatLine; t: TranslateFn }) {
  if (line.role === 'notice') {
    return (
      <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted'), whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {line.text}
      </p>
    );
  }
  if (line.role === 'user') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '85%' }}>
        <span className="sr-only">{t('workbench.chat.you')}</span>
        <div style={userBubbleStyle}>{line.text}</div>
      </div>
    );
  }
  return (
    <div style={{ fontSize: fontSize.md, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%' }}>
      {line.text}
    </div>
  );
}

const userBubbleStyle: CSSProperties = {
  padding: '8px 12px',
  borderRadius: radius.lg,
  background: token('surfaceHover'),
  fontSize: fontSize.md,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};

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
}) {
  const [dropActive, setDropActive] = useState(false);
  const onDragOver = (e: DragEvent): void => {
    if (!onTaskMentionDrop) return;
    if (e.dataTransfer.types.includes('application/x-aiopt-workbench-task')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDropActive(true);
    }
  };
  const onDragLeave = (): void => setDropActive(false);
  const onDrop = (e: DragEvent): void => {
    setDropActive(false);
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
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        borderTop: `1px solid ${token('border')}`,
        padding: space.lg,
        display: 'flex',
        flexDirection: 'column',
        gap: space.sm,
        outline: dropActive ? `2px solid ${token('accent')}` : 'none',
        outlineOffset: -2,
        borderRadius: dropActive ? radius.md : 0,
      }}
    >
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        maxLength={maxLength}
        rows={rows}
        placeholder={placeholder}
        aria-label={placeholder}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '8px 10px',
          borderRadius: radius.md,
          border: `1px solid ${token('borderStrong')}`,
          background: token('surface'),
          color: token('text'),
          resize: 'none',
          fontFamily: 'inherit',
          fontSize: fontSize.base,
          opacity: disabled ? 0.5 : 1,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: space.md }}>
        <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>
          {dropActive && dropHint ? dropHint : sendHint}
        </span>
        <span style={{ flex: 1 }} />
        {streaming && onAbort && abortLabel && (
          <button
            type="button"
            onClick={onAbort}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={smallGhostStyle}
          >
            {abortLabel}
          </button>
        )}
        <button
          type="button"
          onClick={onSend}
          disabled={disabled || draft.trim() === ''}
          {...hoverBackground(token('accent'), token('accentHover'))}
          style={{ ...smallAccentStyle, opacity: disabled || draft.trim() === '' ? 0.5 : 1 }}
        >
          {sendLabel}
        </button>
      </div>
    </div>
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines, footer]);

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      aria-live="polite"
      style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: space.lg, display: 'flex', flexDirection: 'column', gap: space.lg }}
    >
      {lines.length === 0 && !footer && (
        <p style={{ margin: 'auto 0', textAlign: 'center', fontSize: fontSize.base, color: token('textMuted') }}>{empty}</p>
      )}
      {lines.map((line) => (
        <WorkbenchChatBubble key={line.id} line={line} t={t} />
      ))}
      {footer}
    </div>
  );
}

const smallGhostStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  fontSize: fontSize.sm,
  padding: '4px 8px',
  borderRadius: radius.sm,
  color: token('text'),
};

const smallAccentStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  fontSize: fontSize.sm,
  fontWeight: 600,
  padding: '6px 12px',
  borderRadius: radius.sm,
  background: token('accent'),
  color: token('accentText'),
};
