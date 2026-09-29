// Workbench — a multi-agent work assistant built from pi + herdr (see shared/workbench.ts).
//
// Two panes under one status bar: on the left, the chat with the COORDINATOR (a headless pi
// that breaks work down and proposes tasks); on the right, the task board. A proposed task
// runs only when the user picks a folder and presses Run; it then runs as its own pi WORKER in
// a herdr pane, which the user can also watch or take over from a terminal.
//
// The renderer holds no capability here: every action is a named IPC call carrying an opaque
// task/folder id or bounded text, and folders are granted through main's own picker dialog.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useI18n, useT, type Locale, type TranslateFn } from '../../i18n';
import { useWorkbench } from '../../hooks/useWorkbench';
import {
  abortChat,
  createTask,
  deleteConversation,
  openConversation,
  resetChat,
  runAllTasks,
  sendChat,
  startWorkbench,
  stopWorkbench,
  updateTask,
} from '../../lib/workbenchStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CheckboxField } from '../../components/ui/Checkbox';
import { Select } from '../../components/ui/Select';
import { workbenchErrorMessage } from './errors';
import {
  WORKBENCH_LIMITS,
  isLiveTaskStatus,
  taskAllows,
  type ChatItem,
  type ConversationView,
  type FolderView,
  type TaskStatus,
  type TaskView,
  type WorkbenchSnapshot,
  shouldShowTaskPlan,
  taskDependenciesMet,
} from '../../../shared/workbench';
import { TaskDagView } from './TaskDagView';
import { WorkbenchTopBar } from './WorkbenchTopBar';
import { TaskChatPane } from './TaskChatPane';
import { TaskBoardTabRow } from './TaskBoardTabRow';
import { StatusLabel } from './TaskStatusLabel';
import { WorkbenchChatComposer } from './workbenchChat';
import { acceptTaskMentionDrag, insertTaskMention, readTaskMentionDrop, renderTextWithTaskMentions } from './taskMentionUi';
import { WorkbenchSplitPane } from './WorkbenchSplitPane';
import { WorkspaceTabScreen } from '../../components/TabScreenShell';

export function WorkbenchHome() {
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
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selectedTask = wb.tasks.find((task) => task.id === selectedTaskId) ?? null;

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
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <WorkbenchSplitPane
            resizeLabel={t('workbench.splitResizeHandle')}
            left={<ChatPane wb={wb} t={t} run={run} busy={busy} onToggle={() => void toggle()} />}
            right={
              <TaskBoard wb={wb} t={t} run={run} liveCount={liveCount} selectedId={selectedTaskId} onSelectTask={setSelectedTaskId} />
            }
          />
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

// ─── Chat ────────────────────────────────────────────────────────────────────

function ChatPane({
  wb,
  t,
  run,
  busy,
  onToggle,
}: {
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
  busy: boolean;
  onToggle: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const ready = wb.status === 'ready';
  const sessionOn = wb.status === 'ready' || wb.status === 'starting';
  const toggleDisabled = busy || wb.status === 'starting';
  // Switching conversations mid-reply would orphan the reply, so main refuses it; so does the UI.
  const canSwitch = ready && !wb.streaming;

  // Follow the reply as it streams, unless the user has scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [wb.chat]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !ready) return;
    if (await run(() => sendChat(text))) setDraft('');
  };

  const addTaskMention = (taskId: string): void => {
    setDraft((d) => insertTaskMention(d, taskId, WORKBENCH_LIMITS.chatText));
  };

  return (
    <section
      aria-label={t('workbench.chat.title')}
      style={{ ...panelStyle, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <div style={paneHeaderStyle}>
        <h2 style={paneTitleStyle}>{t('workbench.chat.title')}</h2>
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
            opacity: toggleDisabled ? 0.5 : 1,
            flexShrink: 0,
            marginLeft: space.sm,
          }}
        >
          {wb.status === 'starting' ? t('workbench.status.starting') : sessionOn ? t('workbench.stop') : t('workbench.start')}
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          aria-expanded={showHistory}
          onClick={() => setShowHistory((v) => !v)}
          {...hoverBackground(showHistory ? token('surfaceHover') : 'transparent', token('surfaceHover'))}
          style={actionButtonStyle}
        >
          {t('workbench.chat.history')}
          {wb.conversations.length > 0 && (
            <span style={{ marginLeft: space.xs, color: token('textMuted'), fontVariantNumeric: 'tabular-nums' }}>
              {wb.conversations.length}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() =>
            void run(resetChat).then((ok) => {
              if (ok) setShowHistory(false);
            })
          }
          disabled={!canSwitch}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={{ ...actionButtonStyle, opacity: canSwitch ? 1 : 0.5 }}
        >
          {t('workbench.chat.reset')}
        </button>
      </div>
      {showHistory && (
        <HistoryPanel
          conversations={wb.conversations}
          canSwitch={canSwitch}
          t={t}
          run={run}
          onClose={() => setShowHistory(false)}
        />
      )}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        onDragOver={acceptTaskMentionDrag}
        onDrop={(e) => {
          const payload = readTaskMentionDrop(e);
          if (payload) addTaskMention(payload.id);
        }}
        aria-live="polite"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: space.lg, display: 'flex', flexDirection: 'column', gap: space.lg }}
      >
        {wb.chat.length === 0 && (
          <p style={{ margin: 'auto 0', textAlign: 'center', fontSize: fontSize.base, color: token('textMuted') }}>
            {ready ? t('workbench.chat.empty') : t('workbench.chat.notRunning')}
          </p>
        )}
        {wb.chat.map((item) => (
          <ChatEntry key={item.id} item={item} tasks={wb.tasks} t={t} />
        ))}
      </div>
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
        />
      </div>
    </section>
  );
}

function ChatEntry({ item, tasks, t }: { item: ChatItem; tasks: readonly TaskView[]; t: TranslateFn }) {
  switch (item.kind) {
    case 'user':
      return (
        <div style={{ alignSelf: 'flex-end', maxWidth: '85%' }}>
          <span className="sr-only">{t('workbench.chat.you')}</span>
          <div
            style={{
              padding: '8px 12px',
              borderRadius: radius.lg,
              background: token('surfaceHover'),
              fontSize: fontSize.md,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {renderTextWithTaskMentions(item.text, tasks)}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs, maxWidth: '100%' }}>
          {item.thinking && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: fontSize.sm, color: token('textMuted') }}>
                {t('workbench.chat.thinking')}
              </summary>
              <div style={{ ...preStyle, marginTop: space.xs }}>{item.thinking}</div>
            </details>
          )}
          {item.text && (
            <div style={{ fontSize: fontSize.md, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.text}</div>
          )}
          {item.streaming && (
            <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>{t('workbench.chat.replying')}</span>
          )}
        </div>
      );
    case 'tool': {
      const state = !item.done ? 'running' : item.isError ? 'failed' : 'done';
      return (
        <details style={{ fontSize: fontSize.sm }}>
          <summary style={{ cursor: 'pointer', color: token('textMuted') }}>
            <code style={codeStyle}>{item.name}</code> · {t(`workbench.chat.tool.${state}`)}
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
  }
}

/**
 * A localized relative time ("2 hours ago", "刚刚") from `Intl.RelativeTimeFormat`, so the wording
 * needs no i18n entry (see SkillsHome). Null when the time is unknown.
 */
function formatRelative(ms: number, locale: Locale): string | null {
  if (!ms) return null;
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < minute) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < hour) return rtf.format(Math.round(diff / minute), 'minute');
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
  return rtf.format(Math.round(diff / day), 'day');
}

/** Saved conversations: open one to continue it, or delete one (never the current one). */
function HistoryPanel({
  conversations,
  canSwitch,
  t,
  run,
  onClose,
}: {
  conversations: readonly ConversationView[];
  canSwitch: boolean;
  t: TranslateFn;
  run: Runner;
  onClose: () => void;
}) {
  const { locale } = useI18n();
  const [confirmDelete, setConfirmDelete] = useState<ConversationView | null>(null);
  const [deleting, setDeleting] = useState(false);

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !confirmDelete) onClose();
      }}
      style={{
        borderBottom: `1px solid ${token('border')}`,
        background: token('surface'),
        flexShrink: 0,
        maxHeight: 260,
        overflowY: 'auto',
      }}
    >
      {conversations.length === 0 ? (
        <p style={{ margin: 0, padding: space.lg, fontSize: fontSize.sm, color: token('textMuted') }}>{t('workbench.chat.historyEmpty')}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: space.xs }}>
          {conversations.map((c) => {
            const when = formatRelative(c.updatedAt, locale);
            return (
              <li key={c.id} style={{ display: 'flex', alignItems: 'center', gap: space.xs }}>
                <button
                  type="button"
                  aria-current={c.current || undefined}
                  disabled={!canSwitch && !c.current}
                  onClick={() => {
                    if (c.current) {
                      onClose();
                      return;
                    }
                    void run(() => openConversation(c.id)).then((ok) => {
                      if (ok) onClose();
                    });
                  }}
                  {...hoverBackground('transparent', token('surfaceHover'))}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: space.md,
                    padding: '6px 8px',
                    borderRadius: radius.sm,
                    border: 'none',
                    background: 'transparent',
                    color: token('text'),
                    textAlign: 'left',
                    cursor: canSwitch || c.current ? 'pointer' : 'default',
                    opacity: canSwitch || c.current ? 1 : 0.5,
                    fontSize: fontSize.base,
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: c.current ? 600 : 400 }}>
                    {c.title || t('workbench.chat.untitled')}
                  </span>
                  {c.current && (
                    <span style={{ flexShrink: 0, fontSize: fontSize.xs, color: token('accent') }}>{t('workbench.chat.current')}</span>
                  )}
                  {when && <span style={{ flexShrink: 0, fontSize: fontSize.xs, color: token('textMuted') }}>{when}</span>}
                </button>
                {!c.current && (
                  <button
                    type="button"
                    aria-label={`${t('workbench.chat.delete')}: ${c.title || t('workbench.chat.untitled')}`}
                    title={t('workbench.chat.delete')}
                    onClick={() => setConfirmDelete(c)}
                    {...hoverBackground('transparent', token('surfaceHover'))}
                    style={chipCloseStyle}
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t('workbench.chat.deleteConfirm')}
          message={confirmDelete.title || t('workbench.chat.untitled')}
          confirmLabel={t('workbench.chat.delete')}
          cancelLabel={t('workbench.cancel')}
          danger
          busy={deleting}
          onConfirm={() => {
            setDeleting(true);
            void run(() => deleteConversation(confirmDelete.id)).then(() => {
              setDeleting(false);
              setConfirmDelete(null);
            });
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

// ─── Task board ──────────────────────────────────────────────────────────────

// Live work first, then what's waiting for a decision, then what's finished.
const STATUS_GROUP: Record<TaskStatus, number> = {
  blocked: 0,
  review: 0,
  working: 1,
  starting: 1,
  proposed: 2,
  failed: 3,
  stopped: 3,
  done: 4,
};

function TaskBoard({
  wb,
  t,
  run,
  liveCount,
  selectedId,
  onSelectTask,
}: {
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
  liveCount: number;
  selectedId: string | null;
  onSelectTask: (id: string | null) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const tasks = [...wb.tasks].sort(
    (a, b) => STATUS_GROUP[a.status] - STATUS_GROUP[b.status] || a.createdAt - b.createdAt,
  );
  const full = wb.tasks.length >= WORKBENCH_LIMITS.tasks;
  const canRun = wb.status === 'ready' && wb.herdrAvailable && liveCount < WORKBENCH_LIMITS.liveTasks;
  // Only proposals that already name a folder can go; the rest wait for the user to pick one.
  const runnable = wb.tasks.filter(
    (task) =>
      task.status === 'proposed' &&
      task.folderId !== null &&
      wb.folders.some((f) => f.id === task.folderId) &&
      taskDependenciesMet(task, wb.tasks),
  ).length;
  useEffect(() => {
    if (tasks.length === 0) {
      onSelectTask(null);
      return;
    }
    if (!selectedId || !tasks.some((task) => task.id === selectedId)) onSelectTask(tasks[0]!.id);
  }, [tasks, selectedId, onSelectTask]);
  const selectedTask = tasks.find((task) => task.id === selectedId) ?? null;

  return (
    <section
      aria-label={t('workbench.tasks.title')}
      style={{ ...panelStyle, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <TaskBoardTabRow
        tasks={tasks}
        selectedId={selectedId}
        onSelect={onSelectTask}
        t={t}
        wb={wb}
        run={run}
        onEditTask={(id) => setEditingId(id)}
        liveCount={liveCount}
        onNewTask={() => setCreating(true)}
        creating={creating}
        taskFull={full}
        canRun={canRun}
        runnable={runnable}
        selectedTask={selectedTask}
        sessionReady={wb.status === 'ready'}
      />
      {creating && (
        <div style={{ padding: space.md, borderBottom: `1px solid ${token('border')}`, flexShrink: 0 }}>
          <TaskForm
            t={t}
            folders={wb.folders}
            submitLabel={t('workbench.tasks.create')}
            initial={{ title: '', prompt: '', folderId: wb.folders.length === 1 ? (wb.folders[0]?.id ?? null) : null, isolated: false }}
            onCancel={() => setCreating(false)}
            onSubmit={async (draft) => {
              if (await run(() => createTask(draft))) setCreating(false);
            }}
          />
        </div>
      )}
      {shouldShowTaskPlan(wb.tasks) && (
        <details style={{ borderBottom: `1px solid ${token('border')}`, flexShrink: 0 }}>
          <summary
            style={{
              padding: '4px 12px',
              fontSize: fontSize.xs,
              color: token('textMuted'),
              cursor: 'pointer',
              listStyle: 'none',
            }}
          >
            {t('workbench.plan.title')}
          </summary>
          <TaskDagView tasks={wb.tasks} selectedId={selectedId} onSelect={onSelectTask} t={t} />
        </details>
      )}
      {selectedTask && editingId === selectedTask.id ? (
        <div style={{ padding: space.md, borderBottom: `1px solid ${token('border')}`, flexShrink: 0 }}>
          <TaskForm
            t={t}
            folders={wb.folders}
            submitLabel={t('workbench.tasks.save')}
            lockPlace={selectedTask.worktreeDisplay !== null}
            initial={{
              title: selectedTask.title,
              prompt: selectedTask.prompt,
              folderId: selectedTask.folderId,
              isolated: selectedTask.isolated,
            }}
            onCancel={() => setEditingId(null)}
            onSubmit={async (draft) => {
              const placeLocked = selectedTask.worktreeDisplay !== null;
              const ok = await run(() =>
                updateTask(
                  placeLocked
                    ? { taskId: selectedTask.id, title: draft.title, prompt: draft.prompt }
                    : { taskId: selectedTask.id, ...draft },
                ),
              );
              if (ok) setEditingId(null);
            }}
          />
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {selectedTask ? (
          <TaskChatPane task={selectedTask} wb={wb} t={t} run={run} />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: space.lg, flex: 1 }}>
            <p style={{ margin: 0, color: token('textMuted'), fontSize: fontSize.base }}>{t('workbench.tasks.empty')}</p>
          </div>
        )}
      </div>
    </section>
  );
}

interface Draft {
  title: string;
  prompt: string;
  folderId: string | null;
  isolated: boolean;
}

function TaskForm({
  t,
  folders,
  initial,
  submitLabel,
  lockPlace = false,
  onSubmit,
  onCancel,
}: {
  t: TranslateFn;
  folders: readonly FolderView[];
  initial: Draft;
  submitLabel: string;
  /** The task already has a worktree, so where it runs can't change. */
  lockPlace?: boolean;
  onSubmit: (draft: Draft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const valid = draft.title.trim() !== '' && draft.prompt.trim() !== '';
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || saving) return;
        setSaving(true);
        void onSubmit({ ...draft, title: draft.title.trim(), prompt: draft.prompt.trim() }).finally(() => setSaving(false));
      }}
      style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: space.md }}
    >
      <label style={fieldStyle}>
        <span style={labelStyle}>{t('workbench.tasks.titleLabel')}</span>
        <input
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          maxLength={WORKBENCH_LIMITS.taskTitle}
          style={inputStyle}
        />
      </label>
      <label style={fieldStyle}>
        <span style={labelStyle}>{t('workbench.tasks.promptLabel')}</span>
        <textarea
          value={draft.prompt}
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          maxLength={WORKBENCH_LIMITS.taskPrompt}
          rows={5}
          placeholder={t('workbench.tasks.promptPlaceholder')}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
        />
        <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>{t('workbench.tasks.promptHint')}</span>
      </label>
      {!lockPlace && (
        <PlacePicker
          t={t}
          folders={folders}
          folderId={draft.folderId}
          isolated={draft.isolated}
          onChange={(folderId, isolated) => setDraft({ ...draft, folderId, isolated })}
        />
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: space.md }}>
        <button type="button" onClick={onCancel} {...hoverBackground('transparent', token('surfaceHover'))} style={smallGhostStyle}>
          {t('workbench.cancel')}
        </button>
        <button
          type="submit"
          disabled={!valid || saving}
          {...hoverBackground(token('accent'), token('accentHover'))}
          style={{ ...smallAccentStyle, opacity: !valid || saving ? 0.5 : 1 }}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** The folder select + the "own worktree" switch (only offered for a git folder). */
function PlacePicker({
  t,
  folders,
  folderId,
  isolated,
  disabled = false,
  onChange,
}: {
  t: TranslateFn;
  folders: readonly FolderView[];
  folderId: string | null;
  isolated: boolean;
  disabled?: boolean;
  onChange: (folderId: string | null, isolated: boolean) => void;
}) {
  const folder = folders.find((f) => f.id === folderId) ?? null;
  const canIsolate = folder?.isGitRepo === true;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: space.lg, flexWrap: 'wrap' }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: space.sm, minWidth: 0 }}>
        <span style={labelStyle}>{t('workbench.tasks.folderLabel')}</span>
        <Select
          value={folder?.id ?? ''}
          disabled={disabled}
          size="sm"
          style={{ maxWidth: 220 }}
          onChange={(value) => {
            const next = folders.find((f) => f.id === value) ?? null;
            onChange(next?.id ?? null, next?.isGitRepo ? isolated : false);
          }}
          options={[
            { value: '', label: t('workbench.tasks.noFolder') },
            ...folders.map((f) => ({ value: f.id, label: f.name })),
          ]}
        />
      </label>
      <CheckboxField
        title={canIsolate ? undefined : t('workbench.tasks.isolatedUnavailable')}
        label={t('workbench.tasks.isolated')}
        checked={isolated && canIsolate}
        disabled={disabled || !canIsolate}
        onChange={(next) => onChange(folderId, next)}
        style={{ fontSize: fontSize.sm }}
      />
    </div>
  );
}


// ─── Styles ──────────────────────────────────────────────────────────────────

// Opaque panels over the ambient background lines (the screen root stays transparent).
const panelStyle: CSSProperties = {
  border: `1px solid ${token('border')}`,
  borderRadius: radius.lg,
  background: token('bg'),
};

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

const fieldStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: space.xs };

const labelStyle: CSSProperties = { fontSize: fontSize.sm, fontWeight: 600, color: token('textMuted') };

const inputStyle: CSSProperties = {
  padding: '8px 10px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: token('bg'),
  color: token('text'),
  fontSize: fontSize.md,
};

const smallAccentStyle: CSSProperties = {
  padding: '4px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('accent')}`,
  background: token('accent'),
  color: token('accentText'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
};

const smallGhostStyle: CSSProperties = {
  padding: '4px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
};

const actionButtonStyle: CSSProperties = {
  padding: '4px 10px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
  whiteSpace: 'nowrap',
};

const dangerActionButtonStyle: CSSProperties = { ...actionButtonStyle, color: token('danger') };

const chipCloseStyle: CSSProperties = {
  display: 'inline-grid',
  placeItems: 'center',
  width: 20,
  height: 20,
  padding: 0,
  borderRadius: radius.pill,
  border: 'none',
  background: 'transparent',
  color: token('textMuted'),
  cursor: 'pointer',
  fontSize: fontSize.md,
  lineHeight: 1,
};
