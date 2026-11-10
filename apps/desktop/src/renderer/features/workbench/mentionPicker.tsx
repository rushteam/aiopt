// The `@` mention picker shared by the coordinator composer, task follow-ups and the task
// form: typing `@` (at the start or after a space) opens a listbox of tasks, sessions and the
// workbench folders' files, ↑/↓ move, Enter/Tab insert the token, Escape dismisses. Matching
// lives in mentionSuggest.ts, sessionSearch.ts (the Sessions screen's search, so both places
// find the same sessions) and fileMention.ts (path browsing, one directory listing at a time).

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { elevation, token, fontSize, radius, space } from '../../themes/tokens';
import { activeMentionQuery, applyMention, type MentionQuery } from '../sessions/sessionSearch';
import { mentionOptions, moveHighlight, type MentionOption } from './mentionSuggest';
import { fileMentionDir, fileMentionOptions, listingKey, type MentionFolder } from './fileMention';
import { listFolder } from '../../lib/workbenchStore';
import type { TranslateFn } from '../../i18n';
import type { SessionSummary } from '../../../shared/agentSessions';
import type { FolderEntry, TaskView } from '../../../shared/workbench';

export interface MentionSource {
  options: (query: string) => MentionOption[];
  /** Called once per picker opening (e.g. to load the session list). */
  onOpen?: () => void;
  /** Called with each query (e.g. to load the directory a path query browses). */
  onQuery?: (query: string) => void;
  /** True when `query` is already a finished reference (the picker stays closed). */
  isComplete?: (query: string) => boolean;
  /** When set, a picked file / directory reference goes here (a chip) instead of into the text. */
  onRef?: (token: string) => void;
  label: string;
  empty: string;
  hint: string;
  tags: Record<MentionOption['kind'], string>;
}

/**
 * The picker's options and labels. Sessions are fetched when the picker opens (main serves
 * its cached scan). Pass `tasks` only where @task is understood — the coordinator; a worker
 * prompt gets sessions and files only. Directory listings are fetched as a path is typed and
 * dropped when the picker reopens, so a reopened picker sees fresh listings.
 */
export function useMentionSource(
  t: TranslateFn,
  tasks: readonly TaskView[] = [],
  folders: readonly MentionFolder[] = [],
): MentionSource {
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
  const [listings, setListings] = useState<ReadonlyMap<string, readonly FolderEntry[]>>(new Map());
  const requested = useRef(new Set<string>());
  const loadDir = useCallback(
    (query: string) => {
      const dir = fileMentionDir(query, folders);
      if (!dir) return;
      const key = listingKey(dir.folder.id, dir.dirRel);
      if (requested.current.has(key)) return;
      requested.current.add(key);
      listFolder(dir.folder.id, dir.dirRel)
        .then((l) => setListings((m) => new Map(m).set(key, l.entries)))
        .catch(() => setListings((m) => new Map(m).set(key, [])));
    },
    [folders],
  );
  const untitled = t('sessions.untitled');
  const dirTag = t('workbench.chat.mention.dir');
  return {
    options: (query) => {
      const files = fileMentionOptions(query, folders, (id, rel) => listings.get(listingKey(id, rel)), dirTag);
      if (fileMentionDir(query, folders)) return files;
      const rest = mentionOptions(query, tasks, sessions, untitled);
      const nTasks = rest.findIndex((o) => o.kind !== 'task');
      const cut = nTasks < 0 ? rest.length : nTasks;
      return [...rest.slice(0, cut), ...files, ...rest.slice(cut)];
    },
    onOpen: () => {
      loadSessions();
      requested.current.clear();
      setListings(new Map());
    },
    onQuery: loadDir,
    // A file path followed by a space is a finished reference (folder names may hold spaces).
    isComplete: (query) => {
      const dir = fileMentionDir(query, folders);
      return dir !== null && /\s/.test(query.slice(dir.folder.name.length + 1));
    },
    label: t('workbench.chat.mention.label'),
    empty: t('workbench.chat.mention.empty'),
    hint: t('workbench.chat.mention.hint'),
    tags: {
      task: t('workbench.chat.mention.task'),
      session: t('workbench.chat.mention.session'),
      dir: dirTag,
      file: t('workbench.chat.mention.file'),
    },
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
    const found = activeMentionQuery(text, caret);
    const q = found && mentions.isComplete?.(found.query) ? null : found;
    if (q && dismissedAt.current === q.start) return setMention(null);
    if (!q) dismissedAt.current = null;
    if (q && (!mention || mention.start !== q.start)) {
      mentions.onOpen?.();
      setHighlight(0);
    }
    if (q) mentions.onQuery?.(q.query);
    setMention(q);
  };

  const choose = (option: MentionOption): void => {
    const el = textRef.current;
    if (!mention || !el) return;
    if (option.browse) {
      // A directory: replace the query with it and keep browsing inside it.
      const head = draft.slice(0, mention.start) + option.token;
      const tail = draft.slice(el.selectionStart);
      if (head.length + tail.length > maxLength) return;
      const caret = head.length;
      setDraft(head + tail);
      const q = { start: mention.start, query: option.token.slice(1) };
      mentions?.onQuery?.(q.query);
      setMention(q);
      setHighlight(0);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      });
      return;
    }
    if (mentions?.onRef && (option.kind === 'file' || option.kind === 'dir')) {
      // Held as a chip: drop the typed @-query from the text.
      const head = draft.slice(0, mention.start);
      const rest = draft.slice(el.selectionStart);
      const tail = head === '' || /\s$/.test(head) ? rest.replace(/^ /, '') : rest;
      mentions.onRef(option.token);
      setDraft(head + tail);
      setMention(null);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(head.length, head.length);
      });
      return;
    }
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
          tags={mentions.tags}
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
  tags,
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
  tags: Record<MentionOption['kind'], string>;
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
            <span style={mentionTagStyle}>{tags[o.kind]}</span>
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
