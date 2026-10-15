// The `@` mention picker shared by the coordinator composer, task follow-ups and the task
// form: typing `@` (at the start or after a space) opens a listbox of tasks and sessions,
// ↑/↓ move, Enter/Tab insert the token, Escape dismisses. Matching lives in mentionSuggest.ts
// and sessionSearch.ts (the Sessions screen's search), so both places find the same sessions.

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { elevation, token, fontSize, radius, space } from '../../themes/tokens';
import { activeMentionQuery, applyMention, type MentionQuery } from '../sessions/sessionSearch';
import { mentionOptions, moveHighlight, type MentionOption } from './mentionSuggest';
import type { TranslateFn } from '../../i18n';
import type { SessionSummary } from '../../../shared/agentSessions';
import type { TaskView } from '../../../shared/workbench';

export interface MentionSource {
  options: (query: string) => MentionOption[];
  /** Called once per picker opening (e.g. to load the session list). */
  onOpen?: () => void;
  label: string;
  empty: string;
  hint: string;
  taskTag: string;
  sessionTag: string;
}

/**
 * The picker's options and labels. Sessions are fetched when the picker opens (main serves
 * its cached scan). Pass `tasks` only where @task is understood — the coordinator; a worker
 * prompt gets sessions only.
 */
export function useMentionSource(t: TranslateFn, tasks: readonly TaskView[] = []): MentionSource {
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const fetching = useRef(false);
  const loadSessions = useCallback(() => {
    if (fetching.current) return;
    fetching.current = true;
    window.aiopt.sessions
      .list()
      .then((snap) => setSessions(snap.sessions))
      .catch(() => {})
      .finally(() => {
        fetching.current = false;
      });
  }, []);
  const untitled = t('sessions.untitled');
  return {
    options: (query) => mentionOptions(query, tasks, sessions, untitled),
    onOpen: loadSessions,
    label: t('workbench.chat.mention.label'),
    empty: t('workbench.chat.mention.empty'),
    hint: t('workbench.chat.mention.hint'),
    taskTag: t('workbench.chat.mention.task'),
    sessionTag: t('workbench.chat.mention.session'),
  };
}

export type MentionPlacement = 'above' | 'inline';

type TextField = HTMLTextAreaElement;

export interface MentionPicker {
  /** Call from the field's onChange with the field (after updating the draft). */
  sync: (el: TextField) => void;
  /** Call first in the field's onKeyDown; true when the picker consumed the key. */
  onKeyDown: (e: KeyboardEvent<TextField>) => boolean;
  /** Spread on the field: selection tracking, blur, and the combobox ARIA wiring. */
  textareaProps: {
    onSelect?: (e: { currentTarget: TextField }) => void;
    onBlur?: () => void;
    role?: 'combobox';
    'aria-expanded'?: boolean;
    'aria-controls'?: string;
    'aria-activedescendant'?: string;
    'aria-autocomplete'?: 'list';
  };
  /** The listbox, or null while closed. */
  menu: ReactNode;
}

const listId = (base: string): string => `${base}-list`;
const optionId = (base: string, i: number): string => `${base}-opt-${i}`;

export function useMentionPicker({
  mentions,
  draft,
  setDraft,
  maxLength,
  disabled = false,
  textRef,
  placement = 'above',
}: {
  mentions: MentionSource | undefined;
  draft: string;
  setDraft: (v: string) => void;
  maxLength: number;
  disabled?: boolean;
  textRef: RefObject<TextField | null>;
  placement?: MentionPlacement;
}): MentionPicker {
  const idBase = `mention${useId().replace(/:/g, '')}`;
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [highlight, setHighlight] = useState(0);
  /** An @-query the user dismissed with Escape stays closed until the caret leaves it. */
  const dismissedAt = useRef<number | null>(null);
  const options = mention && mentions ? mentions.options(mention.query) : [];
  const menuOpen = mentions !== undefined && mention !== null && !disabled;

  const syncAt = (text: string, caret: number): void => {
    if (!mentions) return;
    const q = activeMentionQuery(text, caret);
    if (q && dismissedAt.current === q.start) return setMention(null);
    if (!q) dismissedAt.current = null;
    if (q && (!mention || mention.start !== q.start)) {
      mentions.onOpen?.();
      setHighlight(0);
    }
    setMention(q);
  };

  const choose = (option: MentionOption): void => {
    const el = textRef.current;
    if (!mention || !el) return;
    const next = applyMention(draft, mention, el.selectionStart, option.token, maxLength);
    setDraft(next.text);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent<TextField>): boolean => {
    if (!menuOpen || e.nativeEvent.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => moveHighlight(h, e.key === 'ArrowDown' ? 1 : -1, options.length));
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && options.length > 0) {
      e.preventDefault();
      choose(options[Math.min(Math.max(highlight, 0), options.length - 1)]!);
      return true;
    }
    if (e.key === 'Escape') {
      // Close only the picker, not an enclosing surface.
      e.preventDefault();
      e.stopPropagation();
      dismissedAt.current = mention.start;
      setMention(null);
      return true;
    }
    return false;
  };

  return {
    sync: (el) => syncAt(el.value, el.selectionStart),
    onKeyDown,
    textareaProps: mentions
      ? {
          onSelect: (e) => syncAt(e.currentTarget.value, e.currentTarget.selectionStart),
          onBlur: () => setMention(null),
          role: 'combobox',
          'aria-expanded': menuOpen,
          'aria-controls': menuOpen ? listId(idBase) : undefined,
          'aria-activedescendant': menuOpen && options.length > 0 ? optionId(idBase, Math.max(highlight, 0)) : undefined,
          'aria-autocomplete': 'list',
        }
      : {},
    menu:
      menuOpen && mentions ? (
        <MentionMenu
          idBase={idBase}
          placement={placement}
          options={options}
          highlight={highlight}
          onHighlight={setHighlight}
          onChoose={choose}
          label={mentions.label}
          empty={mentions.empty}
          hint={mentions.hint}
          taskTag={mentions.taskTag}
          sessionTag={mentions.sessionTag}
        />
      ) : null,
  };
}

function MentionMenu({
  idBase,
  placement,
  options,
  highlight,
  onHighlight,
  onChoose,
  label,
  empty,
  hint,
  taskTag,
  sessionTag,
}: {
  idBase: string;
  placement: MentionPlacement;
  options: MentionOption[];
  highlight: number;
  onHighlight: (i: number) => void;
  onChoose: (option: MentionOption) => void;
  label: string;
  empty: string;
  hint: string;
  taskTag: string;
  sessionTag: string;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    document.getElementById(optionId(idBase, highlight))?.scrollIntoView({ block: 'nearest' });
  }, [idBase, highlight]);
  return (
    <div style={placement === 'above' ? mentionMenuAboveStyle : mentionMenuInlineStyle}>
      <ul ref={listRef} id={listId(idBase)} role="listbox" aria-label={label} style={mentionListStyle}>
        {options.length === 0 && (
          <li style={{ padding: `${space.md}px ${space.lg}px`, fontSize: fontSize.sm, color: token('textMuted') }}>{empty}</li>
        )}
        {options.map((o, i) => (
          <li
            key={o.key}
            id={optionId(idBase, i)}
            role="option"
            aria-selected={i === highlight}
            // mousedown, not click: the textarea must not blur (which closes the menu) first.
            onMouseDown={(e) => {
              e.preventDefault();
              onChoose(o);
            }}
            onMouseEnter={() => onHighlight(i)}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: space.sm,
              padding: `${space.sm}px ${space.lg}px`,
              cursor: 'pointer',
              background: i === highlight ? token('surfaceHover') : 'transparent',
              minWidth: 0,
            }}
          >
            <span style={mentionTagStyle}>{o.kind === 'task' ? taskTag : sessionTag}</span>
            <span style={{ fontSize: fontSize.md, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flexShrink: 1 }}>
              {o.label}
            </span>
            <span
              style={{
                marginLeft: 'auto',
                paddingLeft: space.md,
                fontSize: fontSize.xs,
                color: token('textMuted'),
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                flexShrink: 0,
                maxWidth: '50%',
              }}
            >
              {o.detail}
            </span>
          </li>
        ))}
      </ul>
      <div style={{ padding: `${space.xs}px ${space.lg}px`, borderTop: `1px solid ${token('border')}`, fontSize: fontSize.xs, color: token('textMuted') }}>
        {hint}
      </div>
    </div>
  );
}

const mentionMenuBase: CSSProperties = {
  borderRadius: radius.md,
  border: `1px solid ${token('border')}`,
  background: token('surface'),
  overflow: 'hidden',
};

/** Floats over the thread above a chat composer (whose box has `space.lg` padding). */
const mentionMenuAboveStyle: CSSProperties = {
  ...mentionMenuBase,
  position: 'absolute',
  left: space.lg,
  right: space.lg,
  bottom: '100%',
  marginBottom: -space.sm,
  zIndex: 20,
  boxShadow: elevation('menu'),
};

/** In the flow under a form field: a scrolling form can't clip it. */
const mentionMenuInlineStyle: CSSProperties = { ...mentionMenuBase, marginTop: space.xs };

const mentionListStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: `${space.xs}px 0`,
  maxHeight: 240,
  overflowY: 'auto',
};

const mentionTagStyle: CSSProperties = {
  flexShrink: 0,
  fontSize: fontSize.xs,
  fontWeight: 600,
  padding: '0 6px',
  borderRadius: radius.sm,
  background: token('bg'),
  border: `1px solid ${token('border')}`,
  color: token('textMuted'),
};
