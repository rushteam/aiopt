// Workbench — a multi-agent work assistant built from pi + herdr (see shared/workbench.ts).
//
// Three columns under one status bar, VS Code / Codex style:
//   - the left SIDEBAR is a vertical tab list: the chat with the COORDINATOR (a headless pi
//     that breaks work down and proposes tasks), the PLAN of the conversation it is in (its
//     tasks as a DAG), and each task of that plan as its own tab (detail + worker chat);
//   - the CONTENT shows whichever tab is selected;
//   - the right EXPLORER lists the granted folders as a read-only file tree; clicking a file
//     opens a read-only preview in the content area, from which it can be referenced in the
//     coordinator's composer or revealed in the OS file manager.
// Both sides collapse to an icon rail and are resizable; the layout persists locally. Nothing
// runs until the user approves a task or the whole plan; approved tasks then start as their
// dependencies finish, each as its own pi WORKER in a herdr pane, and the coordinator reviews
// each one to done.
//
// The renderer holds no capability here: every action is a named IPC call carrying an opaque
// task/folder id or bounded text, and folders are granted through main's own picker dialog.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { disabledOpacity, token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT, type TranslateFn } from '../../i18n';
import { useWorkbench } from '../../hooks/useWorkbench';
import { abortChat, loadOlderChat, sendChat, startWorkbench, stopWorkbench } from '../../lib/workbenchStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { workbenchErrorMessage } from './errors';
import {
  WORKBENCH_LIMITS,
  isLiveTaskStatus,
  planTasksOf,
  type ChatItem,
  type FolderView,
  type TaskView,
  type WorkbenchSnapshot,
} from '../../../shared/workbench';
import { PlanPanel } from './PlanPanel';
import { ProposalCard, type ProposalBoard } from './ProposalCard';
import { WorkbenchTopBar } from './WorkbenchTopBar';
import { TaskNodeDetail } from './TaskNodeDetail';
import { StatusLabel } from './TaskStatusLabel';
import { WorkbenchSidebar } from './WorkbenchSidebar';
import { WorkbenchExplorer } from './WorkbenchExplorer';
import { FilePreviewPane } from './FilePreviewPane';
import { PaneResizeHandle } from './workbenchPanes';
import {
  EXPLORER_WIDTH,
  NARROW_WINDOW,
  RAIL_WIDTH,
  SIDEBAR_WIDTH,
  clampWidth,
  readWorkbenchLayout,
  writeWorkbenchLayout,
  type WorkbenchLayout,
} from './workbenchLayout';
import { appendMention, folderMentionText, type WorkbenchView } from './workbenchNav';
import {
  ChatColumn,
  ChatEmptyState,
  ChatLoadingIndicator,
  UserBubble,
  WorkbenchChatComposer,
  assistantTextStyle,
} from './workbenchChat';
import { acceptTaskMentionDrag, insertTaskMention, readTaskMentionDrop, renderTextWithTaskMentions } from './taskMentionUi';
import { useMentionSource } from './mentionPicker';
import type { TaskSeed } from './taskSeed';
import { WorkspaceTabScreen } from '../../components/TabScreenShell';
import { VirtualChatList } from '../../components/ui/VirtualChatList';
import { estimateTextHeight } from '../../lib/virtualList';

/** Whether the window is narrower than NARROW_WINDOW (tracks resizes). */
function useNarrowWindow(): boolean {
  const query = `(max-width: ${NARROW_WINDOW - 1}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const onChange = (): void => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}

export function WorkbenchHome({
  taskSeed = null,
  onTaskSeedUsed,
}: {
  /** Opens the new-task form prefilled (from Sessions). */
  taskSeed?: TaskSeed | null;
  onTaskSeedUsed?: () => void;
} = {}) {
  const t = useT();
  const wb = useWorkbench();
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);

  // One runner for every action on this screen: a failure lands in the shared error line
  // (a coded, localized message — the raw IPC text is never shown).
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setError(workbenchErrorMessage(t, err));
      return false;
    }
  };

  const liveCount = wb.tasks.filter((task) => isLiveTaskStatus(task.status)).length;
  const running = wb.status === 'ready';

  // ── What the content area shows ──
  const [view, setView] = useState<WorkbenchView>({ kind: 'chat' });
  const selectedTask = view.kind === 'task' ? (wb.tasks.find((task) => task.id === view.id) ?? null) : null;
  const previewFolder = view.kind === 'file' ? (wb.folders.find((f) => f.id === view.folderId) ?? null) : null;
  // A task that left the board falls back to the plan it belonged to; a file whose folder was
  // removed falls back to the chat.
  useEffect(() => {
    if (view.kind === 'task' && !wb.tasks.some((task) => task.id === view.id)) setView({ kind: 'plan' });
    if (view.kind === 'file' && !wb.folders.some((f) => f.id === view.folderId)) setView({ kind: 'chat' });
  }, [view, wb.tasks, wb.folders]);
  const selectTask = useCallback((id: string) => setView({ kind: 'task', id }), []);
  // A draft handed over from Sessions opens the plan's new-task form.
  useEffect(() => {
    if (taskSeed) setView({ kind: 'plan' });
  }, [taskSeed]);

  // The coordinator's draft lives here so the explorer can add file references to it.
  const [draft, setDraft] = useState('');
  const insertFile = (folder: FolderView, relPath: string): void => {
    setDraft((d) => appendMention(d, folderMentionText(folder.name, relPath), WORKBENCH_LIMITS.chatText));
    setView({ kind: 'chat' });
  };
  // The tab the preview was opened from, so closing it goes back there.
  const [beforeFile, setBeforeFile] = useState<WorkbenchView>({ kind: 'chat' });
  const openFile = (folder: FolderView, relPath: string): void => {
    if (view.kind !== 'file') setBeforeFile(view);
    setView({ kind: 'file', folderId: folder.id, relPath });
  };

  // ── Layout: persisted widths + collapsed state; a narrow window folds the sidebar ──
  const [layout, setLayout] = useState<WorkbenchLayout>(readWorkbenchLayout);
  const narrow = useNarrowWindow();
  const [narrowOpen, setNarrowOpen] = useState(false);
  useEffect(() => setNarrowOpen(false), [narrow]);
  const sidebarCollapsed = narrow ? !narrowOpen : layout.sidebarCollapsed;
  const updateLayout = (patch: Partial<WorkbenchLayout>): void => {
    setLayout((prev) => {
      const next = { ...prev, ...patch };
      writeWorkbenchLayout(next);
      return next;
    });
  };
  const toggleSidebar = (): void => {
    if (narrow) setNarrowOpen((v) => !v);
    else updateLayout({ sidebarCollapsed: !layout.sidebarCollapsed });
  };

  const toggle = async (): Promise<void> => {
    if (running || wb.status === 'starting') {
      if (liveCount > 0) {
        setConfirmStop(true);
        return;
      }
      setBusy(true);
      await run(stopWorkbench);
      setBusy(false);
      return;
    }
    setBusy(true);
    await run(startWorkbench);
    setBusy(false);
  };

  const content =
    view.kind === 'file' && previewFolder ? (
      // Keyed so switching files resets the preview state.
      <FilePreviewPane
        key={`${previewFolder.id}\u0000${view.relPath}`}
        folder={previewFolder}
        relPath={view.relPath}
        t={t}
        run={run}
        onInsert={() => insertFile(previewFolder, view.relPath)}
        onClose={() => setView(beforeFile)}
      />
    ) : view.kind === 'task' && selectedTask ? (
      <TaskPane task={selectedTask} wb={wb} t={t} run={run} />
    ) : view.kind === 'plan' || view.kind === 'task' ? (
      <PlanPanel
        wb={wb}
        t={t}
        run={run}
        selectedId={null}
        onSelectTask={selectTask}
        seed={taskSeed}
        onSeedUsed={onTaskSeedUsed}
      />
    ) : (
      <ChatPane
        wb={wb}
        t={t}
        run={run}
        busy={busy}
        draft={draft}
        setDraft={setDraft}
        onToggle={() => void toggle()}
        onSelectTask={selectTask}
      />
    );

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* Visually hidden — the tab already names the screen. See ProvidersHome. */}
      <h1 className="sr-only">{t('workbench.title')}</h1>
      <WorkspaceTabScreen>
        <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: space.sm }}>
          <WorkbenchTopBar wb={wb} t={t} run={run} selectedTask={selectedTask} />
          {error && (
            <p role="alert" style={{ margin: 0, color: token('danger'), fontSize: fontSize.base }}>
              {error}
            </p>
          )}
        </div>
        <div style={shellStyle}>
          <div
            style={{
              ...sideColumnStyle,
              width: sidebarCollapsed ? RAIL_WIDTH : layout.sidebarWidth,
              background: token('surface'),
              borderRight: sidebarCollapsed ? 'none' : `1px solid ${token('border')}`,
            }}
          >
            <WorkbenchSidebar
              wb={wb}
              t={t}
              run={run}
              view={view}
              onSelectView={setView}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={toggleSidebar}
            />
          </div>
          {!sidebarCollapsed && (
            <PaneResizeHandle
              side="left"
              width={layout.sidebarWidth}
              min={SIDEBAR_WIDTH.min}
              max={SIDEBAR_WIDTH.max}
              label={t('workbench.sidebar.resize')}
              onResize={(w) => updateLayout({ sidebarWidth: clampWidth(w, SIDEBAR_WIDTH) })}
            />
          )}
          <main style={contentStyle}>{content}</main>
          {!layout.explorerCollapsed && (
            <PaneResizeHandle
              side="right"
              width={layout.explorerWidth}
              min={EXPLORER_WIDTH.min}
              max={EXPLORER_WIDTH.max}
              label={t('workbench.explorer.resize')}
              onResize={(w) => updateLayout({ explorerWidth: clampWidth(w, EXPLORER_WIDTH) })}
            />
          )}
          <div
            style={{
              ...sideColumnStyle,
              width: layout.explorerCollapsed ? RAIL_WIDTH : layout.explorerWidth,
              background: token('surface'),
              borderLeft: layout.explorerCollapsed ? 'none' : `1px solid ${token('border')}`,
            }}
          >
            <WorkbenchExplorer
              folders={wb.folders}
              t={t}
              run={run}
              collapsed={layout.explorerCollapsed}
              onToggleCollapsed={() => updateLayout({ explorerCollapsed: !layout.explorerCollapsed })}
              onOpenFile={openFile}
              selectedFile={view.kind === 'file' ? { folderId: view.folderId, relPath: view.relPath } : null}
            />
          </div>
        </div>
      </WorkspaceTabScreen>
      {confirmStop && (
        <ConfirmDialog
          title={t('workbench.stopConfirm')}
          confirmLabel={t('workbench.stopConfirmYes')}
          cancelLabel={t('workbench.cancel')}
          danger
          busy={busy}
          onConfirm={() => {
            setBusy(true);
            void run(stopWorkbench).then(() => {
              setBusy(false);
              setConfirmStop(false);
            });
          }}
          onCancel={() => setConfirmStop(false)}
        />
      )}
    </div>
  );
}

type Runner = (action: () => Promise<void>) => Promise<boolean>;

// ─── Task ────────────────────────────────────────────────────────────────────

function TaskPane({ task, wb, t, run }: { task: TaskView; wb: WorkbenchSnapshot; t: TranslateFn; run: Runner }) {
  const planTasks = useMemo(
    () => (task.conversationId ? planTasksOf(wb.tasks, task.conversationId) : [task]),
    [wb.tasks, task],
  );
  return (
    <section
      aria-label={task.title}
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      {/* Keyed so switching tasks resets the worker chat's draft and live output. */}
      <TaskNodeDetail key={task.id} task={task} planTasks={planTasks} wb={wb} t={t} run={run} />
    </section>
  );
}

// ─── Chat ────────────────────────────────────────────────────────────────────

function ChatPane({
  wb,
  t,
  run,
  busy,
  draft,
  setDraft,
  onToggle,
  onSelectTask,
}: {
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
  busy: boolean;
  draft: string;
  setDraft: (next: string | ((prev: string) => string)) => void;
  onToggle: () => void;
  onSelectTask: (id: string) => void;
}) {
  const [sent, setSent] = useState(0);
  const ready = wb.status === 'ready';
  const sessionOn = wb.status === 'ready' || wb.status === 'starting';
  const toggleDisabled = busy || wb.status === 'starting';

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !ready) return;
    if (await run(() => sendChat(text))) {
      setDraft('');
      setSent((n) => n + 1);
    }
  };

  // Rows are memoized on (item, renderItem): keep renderItem stable across the 150ms stream
  // pushes, changing only when what a row reads (the board, the session state) really changed.
  const runRef = useRef(run);
  runRef.current = run;
  const stableRun = useCallback<Runner>((action) => runRef.current(action), []);
  const board = useStableValue<ProposalBoard>({
    status: wb.status,
    herdrAvailable: wb.herdrAvailable,
    tasks: wb.tasks,
    folders: wb.folders,
  });
  const renderItem = useCallback(
    (item: ChatItem) => (
      <ChatColumn>
        {item.kind === 'proposal' ? (
          <ProposalCard taskIds={item.taskIds} wb={board} t={t} run={stableRun} onSelectTask={onSelectTask} />
        ) : (
          <ChatEntry item={item} tasks={board.tasks} t={t} />
        )}
      </ChatColumn>
    ),
    [board, t, stableRun, onSelectTask],
  );
  // The coordinator is busy but has not streamed a word yet: show it is working.
  const last = wb.chat[wb.chat.length - 1];
  const waiting = wb.streaming && !(last?.kind === 'assistant' && last.streaming && last.text !== '');

  const addTaskMention = (taskId: string): void => {
    setDraft((d) => insertTaskMention(d, taskId, WORKBENCH_LIMITS.chatText));
  };

  const mentions = useMentionSource(t, wb.tasks);

  return (
    <section
      aria-label={t('workbench.chat.title')}
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <div style={paneHeaderStyle}>
        <h2 style={paneTitleStyle}>{t('workbench.chat.title')}</h2>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onToggle}
          disabled={toggleDisabled}
          title={sessionOn ? t('workbench.stop') : t('workbench.start')}
          {...(sessionOn
            ? hoverBackground('transparent', token('surfaceHover'))
            : hoverBackground(token('accent'), token('accentHover')))}
          style={{
            all: 'unset',
            cursor: toggleDisabled ? 'default' : 'pointer',
            fontSize: fontSize.xs,
            fontWeight: 600,
            padding: '3px 10px',
            borderRadius: radius.sm,
            border: sessionOn ? `1px solid ${token('borderStrong')}` : 'none',
            background: sessionOn ? 'transparent' : token('accent'),
            color: sessionOn ? token('text') : token('accentText'),
            opacity: toggleDisabled ? disabledOpacity : 1,
            flexShrink: 0,
          }}
        >
          {wb.status === 'starting' ? t('workbench.status.starting') : sessionOn ? t('workbench.stop') : t('workbench.start')}
        </button>
      </div>
      <VirtualChatList
        items={wb.chat}
        getKey={chatItemKey}
        renderItem={renderItem}
        estimateHeight={estimateChatItemHeight}
        hasMore={wb.chatHasMore}
        onLoadMore={loadOlderChat}
        followSignal={`${wb.chatEpoch}:${sent}`}
        jumpLabel={t('workbench.chat.jumpToLatest')}
        loadingLabel={t('workbench.chat.loadingOlder')}
        onDragOver={acceptTaskMentionDrag}
        onDrop={(e) => {
          const payload = readTaskMentionDrop(e);
          if (payload) addTaskMention(payload.id);
        }}
        gap={space.xl}
        padding={space.xl}
        footer={
          waiting ? (
            <ChatColumn>
              <ChatLoadingIndicator label={t('workbench.chat.working')} />
            </ChatColumn>
          ) : undefined
        }
        empty={
          <ChatEmptyState
            title={t('workbench.chat.emptyTitle')}
            body={ready ? t('workbench.chat.empty') : t('workbench.chat.notRunning')}
          />
        }
      />
      <div style={{ flexShrink: 0 }}>
        <WorkbenchChatComposer
          draft={draft}
          setDraft={setDraft}
          onSend={() => void send()}
          disabled={!ready}
          streaming={wb.streaming}
          onAbort={() => void run(abortChat)}
          maxLength={WORKBENCH_LIMITS.chatText}
          placeholder={t('workbench.chat.placeholder')}
          sendHint={t('workbench.chat.sendHint')}
          sendLabel={t('workbench.chat.send')}
          abortLabel={t('workbench.chat.abort')}
          onTaskMentionDrop={ready ? addTaskMention : undefined}
          dropHint={t('workbench.chat.taskMentionDrop')}
          mentions={mentions}
        />
      </div>
    </section>
  );
}

const chatItemKey = (item: ChatItem): string => item.id;

/** A first-render height guess (px); real heights replace it once a row has rendered. */
function estimateChatItemHeight(item: ChatItem, width: number): number {
  const perLine = Math.max(20, Math.floor(width / 9));
  switch (item.kind) {
    case 'user':
      return estimateTextHeight(item.text, Math.floor(perLine * 0.85));
    case 'assistant':
      return estimateTextHeight(item.text, perLine, 21, item.thinking ? 28 : 4);
    case 'proposal':
      return 64 + 56 * item.taskIds.length;
    case 'taskUpdate':
      return 32 + 24 * item.tasks.length;
    default:
      return 22;
  }
}

/**
 * The previous value while `next` is structurally equal (JSON), so a memo keyed on it survives
 * the snapshot pushes that rebuild every array. Bounded: the board is capped in shared/workbench.
 */
function useStableValue<T>(next: T): T {
  const ref = useRef<{ value: T; json: string } | null>(null);
  const json = JSON.stringify(next);
  if (!ref.current || ref.current.json !== json) ref.current = { value: next, json };
  return ref.current.value;
}

function ChatEntry({ item, tasks, t }: { item: ChatItem; tasks: readonly TaskView[]; t: TranslateFn }) {
  switch (item.kind) {
    case 'user':
      return <UserBubble t={t}>{renderTextWithTaskMentions(item.text, tasks)}</UserBubble>;
    case 'assistant':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs, maxWidth: '100%' }}>
          {item.thinking && (
            <details>
              <summary style={disclosureSummaryStyle}>{t('workbench.chat.thinking')}</summary>
              <div style={thinkingStyle}>{item.thinking}</div>
            </details>
          )}
          {item.text && <div style={assistantTextStyle}>{item.text}</div>}
          {item.streaming && item.text === '' && <ChatLoadingIndicator label={t('workbench.chat.replying')} />}
        </div>
      );
    case 'tool': {
      const state = !item.done ? 'running' : item.isError ? 'failed' : 'done';
      return (
        <details style={{ fontSize: fontSize.sm }}>
          <summary style={disclosureSummaryStyle}>
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                marginRight: space.sm,
                borderRadius: radius.pill,
                verticalAlign: 'middle',
                background: state === 'failed' ? token('danger') : state === 'done' ? token('success') : token('accent'),
              }}
            />
            <code style={codeStyle}>{item.name}</code>
            <span style={{ marginLeft: space.sm }}>{t(`workbench.chat.tool.${state}`)}</span>
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs, marginTop: space.xs }}>
            {item.args && (
              <>
                <span style={{ color: token('textMuted') }}>{t('workbench.chat.tool.args')}</span>
                <div style={preStyle}>{item.args}</div>
              </>
            )}
            {item.result && (
              <>
                <span style={{ color: token('textMuted') }}>{t('workbench.chat.tool.result')}</span>
                <div style={preStyle}>{item.result}</div>
              </>
            )}
          </div>
        </details>
      );
    }
    case 'error':
      return (
        <p role="alert" style={{ margin: 0, fontSize: fontSize.base, color: token('danger'), overflowWrap: 'anywhere' }}>
          {t('workbench.chat.error')} {item.message}
        </p>
      );
    case 'notice':
      return (
        <p style={{ margin: 0, textAlign: 'center', fontSize: fontSize.sm, color: token('textMuted') }}>
          {t(`workbench.notice.${item.code}`)}
        </p>
      );
    case 'taskUpdate':
      // Sent by the app (not the user) when tasks need attention; the coordinator's reply follows.
      return (
        <div style={{ ...cardStyle, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: space.xs }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: token('textMuted') }}>{t('workbench.chat.taskUpdate')}</span>
          {item.tasks.map((task, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: space.md, fontSize: fontSize.base, minWidth: 0 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
              <StatusLabel status={task.status} t={t} />
            </div>
          ))}
        </div>
      );
    case 'proposal':
      // Drawn by ChatPane as a ProposalCard (it needs the board and the runner).
      return null;
  }
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const cardStyle: CSSProperties = {
  border: `1px solid ${token('border')}`,
  borderRadius: radius.md,
  background: token('surface'),
  padding: space.lg,
};

const paneHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.md,
  padding: '8px 12px',
  borderBottom: `1px solid ${token('border')}`,
  flexShrink: 0,
};

const paneTitleStyle: CSSProperties = { margin: 0, fontSize: fontSize.lg, fontWeight: 600 };

const disclosureSummaryStyle: CSSProperties = {
  cursor: 'pointer',
  fontSize: fontSize.sm,
  color: token('textMuted'),
  userSelect: 'none',
};

// Reasoning reads as an aside: a quiet indented column, not a boxed block.
const thinkingStyle: CSSProperties = {
  marginTop: space.xs,
  padding: `${space.xs}px 0 ${space.xs}px ${space.lg}px`,
  borderLeft: `2px solid ${token('border')}`,
  fontSize: fontSize.sm,
  lineHeight: 1.6,
  color: token('textMuted'),
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  userSelect: 'text',
};

const codeStyle: CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: fontSize.xs,
  color: token('text'),
  userSelect: 'text',
};

const preStyle: CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  borderRadius: radius.sm,
  background: token('surface'),
  border: `1px solid ${token('border')}`,
  fontFamily: 'ui-monospace, monospace',
  fontSize: fontSize.xs,
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  userSelect: 'text',
};

// One opaque frame over the ambient background lines (the screen root stays transparent):
// sidebar | content | explorer, separated by 1px dividers.
const shellStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  overflow: 'hidden',
  border: `1px solid ${token('border')}`,
  borderRadius: radius.lg,
  background: token('bg'),
};

const sideColumnStyle: CSSProperties = {
  flexShrink: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const contentStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};
