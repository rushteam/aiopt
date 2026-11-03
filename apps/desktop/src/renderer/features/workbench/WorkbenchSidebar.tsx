// The Workbench's left sidebar: vertical tabs for what the content area shows — the
// coordinator chat, the plan graph, and each task of the plan (indented by dependency layer,
// with its status dot). Tasks of other conversations fold away at the bottom. The header
// switches conversations (history) and starts a new one.
//
// Collapsed, it is a 40px icon rail that keeps the status dots, so live work stays visible.
// The list is one vertical tablist: ↑/↓ (and Home/End) move between items.

import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { resetChat } from '../../lib/workbenchStore';
import { planProgress, planTasksOf, type TaskStatus, type TaskView, type WorkbenchSnapshot } from '../../../shared/workbench';
import { HistoryPanel } from './HistoryPanel';
import { ChatIcon, ChevronIcon, PanelIcon, PlanIcon, PlusIcon } from './workbenchIcons';
import { IconButton } from './workbenchPanes';
import { sidebarTaskOrder, viewKey, type WorkbenchView } from './workbenchNav';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

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
  // Switching conversations mid-reply would orphan the reply, so main refuses it; so does the UI.
  const canSwitch = wb.status === 'ready' && !wb.streaming;
  const current = wb.conversations.find((c) => c.current) ?? null;
  const selectedKey = viewKey(view);
  const othersOpen = showOthers || others.some((x) => viewKey({ kind: 'task', id: x.id }) === selectedKey);

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
