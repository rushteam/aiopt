// The Workbench's left sidebar: vertical tabs for what the content area shows — the
// coordinator chat, the plan graph, and each task of the plan (indented by dependency layer,
// with its status dot). Tasks of other conversations fold away at the bottom. The header
// switches conversations (history) and starts a new one.
//
// Collapsed, it is a 40px icon rail that keeps the status dots, so live work stays visible.
// The list is one vertical tablist: ↑/↓ (and Home/End) move between items.
//
// The search box finds a task by title, prompt, follow-ups or branch across every conversation,
// and a saved conversation by its title or anything the user or the assistant said in it (main
// reads the session files; the title hits show at once, the full-text ones after a short pause).
// The results replace the list until the box is cleared. ⌘K focuses the box; ⌘[ / ⌘] step to
// the next older / newer saved conversation.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { disabledOpacity, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { openConversation, resetChat, searchConversationsFullText } from '../../lib/workbenchStore';
import { useAppShortcut } from '../../hooks/useAppShortcut';
import {
  planProgress,
  planTasksOf,
  type ConversationMatch,
  type TaskStatus,
  type TaskView,
  type WorkbenchSnapshot,
} from '../../../shared/workbench';
import { HistoryPanel } from './HistoryPanel';
import { ChatIcon, ChevronIcon, CloseIcon, PanelIcon, PlanIcon, PlusIcon, SearchIcon, TimelineIcon } from './workbenchIcons';
import { IconButton } from './workbenchPanes';
import { searchConversations, searchTasks, sidebarTaskOrder, viewKey, type WorkbenchView } from './workbenchNav';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

/** How long typing pauses before main reads the conversations (title hits need no wait). */
const FULL_TEXT_DEBOUNCE_MS = 180;

interface ConversationResult {
  id: string;
  title: string;
  current: boolean;
  match: ConversationMatch;
  snippet: string;
}

/** The status-dot colour (same scale as StatusLabel and the DAG). */
export function statusDotColor(status: TaskStatus, approved: boolean): string {
  if (status === 'working' || status === 'starting') return token('accent');
  if (status === 'blocked' || status === 'failed') return token('danger');
  if (status === 'review' || status === 'done') return token('success');
  if (approved && status === 'proposed') return token('accent');
  return token('borderStrong');
}

function statusText(task: TaskView, t: TranslateFn): string {
  return task.approved && task.status === 'proposed' ? t('workbench.plan.queued') : t(`workbench.taskStatus.${task.status}`);
}

export function WorkbenchSidebar({
  wb,
  t,
  run,
  view,
  onSelectView,
  collapsed,
  onToggleCollapsed,
}: {
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
  view: WorkbenchView;
  onSelectView: (view: WorkbenchView) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const conversationId = wb.currentConversationId;
  const plan = useMemo(() => planTasksOf(wb.tasks, conversationId), [wb.tasks, conversationId]);
  const ordered = useMemo(() => sidebarTaskOrder(plan), [plan]);
  const others = useMemo(
    () => wb.tasks.filter((x) => x.conversationId !== conversationId || conversationId === null),
    [wb.tasks, conversationId],
  );
  const progress = planProgress(plan);
  const [showHistory, setShowHistory] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [focusSearch, setFocusSearch] = useState(false);
  const taskHits = useMemo(() => searchTasks(wb.tasks, query), [wb.tasks, query]);
  const titleHits = useMemo(() => searchConversations(wb.conversations, query), [wb.conversations, query]);
  const searching = query.trim() !== '';
  // Main's full-text answer for `query`; a newer keystroke bumps the generation, so a late
  // answer to an older query is dropped instead of flashing in.
  const [fullText, setFullText] = useState<{ query: string; hits: ConversationResult[] } | null>(null);
  const searchGeneration = useRef(0);
  const conversationsKey = wb.conversations.map((c) => `${c.id}:${c.updatedAt}:${c.title}`).join('|');
  useEffect(() => {
    const generation = ++searchGeneration.current;
    if (!searching) {
      setFullText(null);
      return;
    }
    const timer = window.setTimeout(() => {
      searchConversationsFullText(query)
        .then((result) => {
          if (generation !== searchGeneration.current) return;
          setFullText({
            query,
            hits: result.hits.map((h) => ({ id: h.id, title: h.title, current: false, match: h.match, snippet: h.snippet })),
          });
        })
        .catch(() => {
          // Title hits stay; a failed read only loses the full-text ones.
          if (generation === searchGeneration.current) setFullText(null);
        });
    }, FULL_TEXT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, searching, conversationsKey]);
  const conversationHits = useMemo((): ConversationResult[] => {
    const currentId = wb.conversations.find((c) => c.current)?.id;
    if (fullText && fullText.query === query) {
      return fullText.hits.map((h) => ({ ...h, current: h.id === currentId }));
    }
    return titleHits.map((c) => ({ id: c.id, title: c.title, current: c.current, match: 'title', snippet: '' }));
  }, [fullText, query, titleHits, wb.conversations]);

  // The rail's search button expands the sidebar first; focus the box once it is there.
  useEffect(() => {
    if (!focusSearch || collapsed) return;
    searchRef.current?.focus();
    setFocusSearch(false);
  }, [focusSearch, collapsed]);
  // Switching conversations mid-reply would orphan the reply, so main refuses it; so does the UI.
  const canSwitch = wb.status === 'ready' && !wb.streaming;
  const current = wb.conversations.find((c) => c.current) ?? null;
  const selectedKey = viewKey(view);
  const othersOpen = showOthers || others.some((x) => viewKey({ kind: 'task', id: x.id }) === selectedKey);

  const focusSearchBox = (): void => {
    if (collapsed) {
      setFocusSearch(true);
      onToggleCollapsed();
      return;
    }
    searchRef.current?.focus();
    searchRef.current?.select();
  };
  useAppShortcut('workbench-search', focusSearchBox);

  // Saved conversations are listed newest first; a fresh (unsaved) one sits before them all.
  const stepConversation = (direction: 1 | -1): void => {
    if (!canSwitch || wb.conversations.length === 0) return;
    const at = wb.conversations.findIndex((c) => c.current);
    const next = at < 0 ? (direction === 1 ? 0 : -1) : at + direction;
    const target = wb.conversations[next];
    if (!target) return;
    void run(() => openConversation(target.id)).then((ok) => {
      if (ok) onSelectView({ kind: 'chat' });
    });
  };
  useAppShortcut('workbench-older-conversation', () => stepConversation(1));
  useAppShortcut('workbench-newer-conversation', () => stepConversation(-1));

  const newConversation = (): void => {
    void run(resetChat).then((ok) => {
      if (!ok) return;
      setShowHistory(false);
      onSelectView({ kind: 'chat' });
    });
  };

  // Roving focus over the tabs: arrows move focus and select, like a vertical tablist.
  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const tabs = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    if (tabs.length === 0) return;
    e.preventDefault();
    const at = tabs.findIndex((el) => el === document.activeElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? tabs.length - 1
          : Math.max(0, Math.min(tabs.length - 1, (at < 0 ? 0 : at) + (e.key === 'ArrowDown' ? 1 : -1)));
    tabs[next]?.focus();
    tabs[next]?.click();
  };

  const tab = (target: WorkbenchView, label: string, content: ReactNode, opts: { depth?: number; title?: string } = {}) => {
    const selected = viewKey(target) === selectedKey;
    return (
      <button
        key={viewKey(target)}
        type="button"
        role="tab"
        aria-selected={selected}
        aria-label={label}
        title={opts.title ?? label}
        // A file preview selects no tab; the chat tab then keeps the list reachable by Tab.
        tabIndex={selected || (view.kind === 'file' && target.kind === 'chat') ? 0 : -1}
        onClick={() => onSelectView(target)}
        {...hoverBackground(selected ? token('surfaceHover') : 'transparent', token('surfaceHover'))}
        style={collapsed ? railTabStyle(selected) : tabStyle(selected, opts.depth ?? 0)}
      >
        {content}
      </button>
    );
  };

  const openSearchedConversation = (id: string, current: boolean): void => {
    if (current) {
      onSelectView({ kind: 'chat' });
      return;
    }
    void run(() => openConversation(id)).then((ok) => {
      if (ok) onSelectView({ kind: 'chat' });
    });
  };

  const taskTab = (task: TaskView, depth: number) => {
    const status = statusText(task, t);
    const dot = <span aria-hidden style={{ ...dotStyle, background: statusDotColor(task.status, task.approved) }} />;
    return tab({ kind: 'task', id: task.id }, `${task.title} · ${status}`, collapsed ? dot : (
      <>
        {dot}
        <span style={ellipsisStyle}>{task.title}</span>
      </>
    ), { depth });
  };

  if (collapsed) {
    return (
      <nav aria-label={t('workbench.sidebar.label')} style={{ ...railStyle, borderRight: `1px solid ${token('border')}` }}>
        <IconButton label={t('workbench.sidebar.expand')} onClick={onToggleCollapsed} expanded={false}>
          <PanelIcon side="left" />
        </IconButton>
        <IconButton
          label={t('workbench.sidebar.search')}
          onClick={focusSearchBox}
        >
          <SearchIcon />
        </IconButton>
        <div
          ref={listRef}
          role="tablist"
          aria-orientation="vertical"
          aria-label={t('workbench.sidebar.label')}
          onKeyDown={onListKeyDown}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minHeight: 0, overflowY: 'auto' }}
        >
          {tab({ kind: 'chat' }, t('workbench.chat.title'), <ChatIcon />)}
          {tab({ kind: 'plan' }, t('workbench.plan.title'), <PlanIcon />)}
          {tab({ kind: 'timeline' }, t('workbench.timeline.title'), <TimelineIcon />)}
          {ordered.length > 0 && <span aria-hidden style={railDividerStyle} />}
          {ordered.map(({ task }) => taskTab(task, 0))}
        </div>
        <span style={{ flex: 1 }} />
        <IconButton label={t('workbench.chat.reset')} onClick={newConversation} disabled={!canSwitch}>
          <PlusIcon />
        </IconButton>
      </nav>
    );
  }

  return (
    <nav aria-label={t('workbench.sidebar.label')} style={sidebarStyle}>
      <div style={headerStyle}>
        <button
          type="button"
          aria-expanded={showHistory}
          aria-label={`${t('workbench.chat.history')}: ${current?.title || t('workbench.chat.untitled')}`}
          title={t('workbench.chat.history')}
          onClick={() => setShowHistory((v) => !v)}
          {...hoverBackground(showHistory ? token('surfaceHover') : 'transparent', token('surfaceHover'))}
          style={conversationButtonStyle(showHistory)}
        >
          <span style={{ ...ellipsisStyle, fontWeight: 600 }}>{current?.title || t('workbench.chat.untitled')}</span>
          <ChevronIcon open={showHistory} />
        </button>
        <IconButton label={t('workbench.chat.reset')} onClick={newConversation} disabled={!canSwitch}>
          <PlusIcon />
        </IconButton>
        <IconButton label={t('workbench.sidebar.collapse')} onClick={onToggleCollapsed} expanded>
          <PanelIcon side="left" />
        </IconButton>
      </div>
      {showHistory && (
        <HistoryPanel
          conversations={wb.conversations}
          canSwitch={canSwitch}
          t={t}
          run={async (action) => {
            const ok = await run(action);
            if (ok) onSelectView({ kind: 'chat' });
            return ok;
          }}
          onClose={() => setShowHistory(false)}
        />
      )}
      <div style={searchRowStyle}>
        <span aria-hidden style={searchIconStyle}>
          <SearchIcon size={14} />
        </span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query !== '') {
              e.stopPropagation();
              setQuery('');
            } else if (e.key === 'ArrowDown') {
              const first = listRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
              if (first) {
                e.preventDefault();
                first.focus();
              }
            }
          }}
          placeholder={t('workbench.sidebar.searchPlaceholder')}
          aria-label={t('workbench.sidebar.search')}
          style={searchInputStyle}
        />
        {query !== '' && (
          <IconButton label={t('workbench.sidebar.searchClear')} size={22} onClick={() => {
            setQuery('');
            searchRef.current?.focus();
          }} style={searchClearStyle}>
            <CloseIcon />
          </IconButton>
        )}
      </div>
      {searching ? (
        <div
          ref={listRef}
          role="region"
          aria-label={t('workbench.sidebar.searchResults')}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
            const at = rows.findIndex((el) => el === document.activeElement);
            e.preventDefault();
            if (e.key === 'ArrowUp' && at <= 0) searchRef.current?.focus();
            else rows[Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))]?.focus();
          }}
          style={listStyle}
        >
          {taskHits.length === 0 && conversationHits.length === 0 && (
            <p style={searchEmptyStyle}>{t('workbench.sidebar.searchEmpty')}</p>
          )}
          {taskHits.length > 0 && <p style={sectionLabelStyle}>{t('workbench.sidebar.searchTasks')}</p>}
          {taskHits.map(({ task, snippet }) => {
            const selected = viewKey({ kind: 'task', id: task.id }) === selectedKey;
            return (
              <button
                key={task.id}
                type="button"
                aria-current={selected || undefined}
                title={task.title}
                onClick={() => onSelectView({ kind: 'task', id: task.id })}
                {...hoverBackground(selected ? token('surfaceHover') : 'transparent', token('surfaceHover'))}
                style={resultStyle(selected)}
              >
                <span style={resultTitleRowStyle}>
                  <span aria-hidden style={{ ...dotStyle, background: statusDotColor(task.status, task.approved) }} />
                  <span style={ellipsisStyle}>{task.title}</span>
                  <span style={countStyle}>{statusText(task, t)}</span>
                </span>
                {snippet && <span style={snippetStyle}>{snippet}</span>}
              </button>
            );
          })}
          {conversationHits.length > 0 && <p style={sectionLabelStyle}>{t('workbench.sidebar.searchConversations')}</p>}
          {conversationHits.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-current={c.current || undefined}
              disabled={!canSwitch && !c.current}
              onClick={() => openSearchedConversation(c.id, c.current)}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={{ ...resultStyle(false), opacity: canSwitch || c.current ? 1 : disabledOpacity }}
            >
              <span style={resultTitleRowStyle}>
                <ChatIcon size={14} />
                <span style={{ ...ellipsisStyle, fontWeight: c.current ? 600 : 400 }}>{c.title || t('workbench.chat.untitled')}</span>
                {c.current && <span style={{ ...countStyle, color: token('accent') }}>{t('workbench.chat.current')}</span>}
              </span>
              {c.snippet && (
                <span style={snippetStyle}>
                  <span style={{ fontWeight: 600 }}>
                    {t(c.match === 'user' ? 'workbench.sidebar.searchMatchUser' : 'workbench.sidebar.searchMatchAssistant')}
                    {': '}
                  </span>
                  {c.snippet}
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
      <div
        ref={listRef}
        role="tablist"
        aria-orientation="vertical"
        aria-label={t('workbench.sidebar.label')}
        onKeyDown={onListKeyDown}
        style={listStyle}
      >
        {tab(
          { kind: 'chat' },
          t('workbench.chat.title'),
          <>
            <ChatIcon />
            <span style={ellipsisStyle}>{t('workbench.chat.title')}</span>
            {wb.streaming && <span aria-hidden style={{ ...dotStyle, background: token('accent') }} />}
          </>,
        )}
        {tab(
          { kind: 'plan' },
          t('workbench.plan.title'),
          <>
            <PlanIcon />
            <span style={ellipsisStyle}>{t('workbench.plan.title')}</span>
            {progress.total > 0 && (
              <span style={countStyle}>
                {progress.done}/{progress.total}
              </span>
            )}
          </>,
        )}
        {tab(
          { kind: 'timeline' },
          t('workbench.timeline.title'),
          <>
            <TimelineIcon />
            <span style={ellipsisStyle}>{t('workbench.timeline.title')}</span>
          </>,
        )}
        {ordered.map(({ task, depth }) => taskTab(task, depth + 1))}
        {others.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={othersOpen}
              onClick={() => setShowOthers(!othersOpen)}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={groupToggleStyle}
            >
              <ChevronIcon open={othersOpen} />
              <span style={ellipsisStyle}>{t('workbench.plan.others')}</span>
              <span style={countStyle}>{others.length}</span>
            </button>
            {othersOpen && others.map((task) => taskTab(task, 1))}
          </>
        )}
      </div>
      )}
    </nav>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const sidebarStyle: CSSProperties = {
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
  padding: `${space.sm}px ${space.sm}px ${space.xs}px`,
  flexShrink: 0,
};

const listStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  padding: `${space.xs}px ${space.sm}px ${space.md}px`,
};

const searchRowStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  padding: `0 ${space.sm}px ${space.xs}px`,
  flexShrink: 0,
};

const searchIconStyle: CSSProperties = {
  position: 'absolute',
  left: space.sm + 8,
  color: token('textMuted'),
  pointerEvents: 'none',
  display: 'grid',
};

const searchInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 28,
  boxSizing: 'border-box',
  padding: '0 28px 0 28px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: token('bg'),
  color: token('text'),
  fontSize: fontSize.sm,
};

const searchClearStyle: CSSProperties = { position: 'absolute', right: space.sm + 3 };

const sectionLabelStyle: CSSProperties = {
  margin: `${space.sm}px 0 2px`,
  padding: '0 8px',
  fontSize: fontSize.xs,
  fontWeight: 600,
  color: token('textMuted'),
};

const searchEmptyStyle: CSSProperties = {
  margin: 0,
  padding: `${space.md}px 8px`,
  fontSize: fontSize.sm,
  color: token('textMuted'),
};

function resultStyle(selected: boolean): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 2,
    width: '100%',
    boxSizing: 'border-box',
    padding: '5px 8px',
    border: 'none',
    borderRadius: radius.sm,
    background: selected ? token('surfaceHover') : 'transparent',
    color: token('text'),
    fontSize: fontSize.base,
    textAlign: 'left',
    cursor: 'pointer',
    flexShrink: 0,
  };
}

const resultTitleRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: space.md, minWidth: 0 };

const snippetStyle: CSSProperties = {
  paddingLeft: 8 + space.md,
  fontSize: fontSize.xs,
  color: token('textMuted'),
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflowWrap: 'anywhere',
};

const ellipsisStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const dotStyle: CSSProperties = { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 };

const countStyle: CSSProperties = {
  flexShrink: 0,
  fontSize: fontSize.xs,
  color: token('textMuted'),
  fontVariantNumeric: 'tabular-nums',
};

function conversationButtonStyle(open: boolean): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    height: 28,
    padding: '0 8px',
    border: 'none',
    borderRadius: radius.sm,
    background: open ? token('surfaceHover') : 'transparent',
    color: token('text'),
    fontSize: fontSize.base,
    textAlign: 'left',
    cursor: 'pointer',
  };
}

function tabStyle(selected: boolean, depth: number): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 30,
    padding: `4px 8px 4px ${8 + depth * 14}px`,
    border: 'none',
    borderRadius: radius.sm,
    background: selected ? token('surfaceHover') : 'transparent',
    color: selected ? token('text') : token('textMuted'),
    fontSize: fontSize.base,
    fontWeight: selected ? 600 : 400,
    textAlign: 'left',
    cursor: 'pointer',
    flexShrink: 0,
  };
}

function railTabStyle(selected: boolean): CSSProperties {
  return {
    display: 'grid',
    placeItems: 'center',
    width: 28,
    height: 28,
    padding: 0,
    flexShrink: 0,
    border: 'none',
    borderRadius: radius.sm,
    background: selected ? token('surfaceHover') : 'transparent',
    color: selected ? token('text') : token('textMuted'),
    cursor: 'pointer',
    boxShadow: selected ? `inset 0 0 0 1px ${token('borderStrong')}` : 'none',
  };
}

const railDividerStyle: CSSProperties = {
  width: 16,
  height: 1,
  margin: `${space.xs}px 0`,
  background: token('border'),
  flexShrink: 0,
};

const groupToggleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.sm,
  width: '100%',
  boxSizing: 'border-box',
  marginTop: space.md,
  padding: '4px 8px',
  border: 'none',
  borderRadius: radius.sm,
  background: 'transparent',
  color: token('textMuted'),
  fontSize: fontSize.sm,
  textAlign: 'left',
  cursor: 'pointer',
  flexShrink: 0,
};
