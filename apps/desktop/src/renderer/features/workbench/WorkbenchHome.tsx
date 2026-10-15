// Workbench — a multi-agent work assistant built from pi + herdr (see shared/workbench.ts).
//
// Two panes under one status bar: on the left, the chat with the COORDINATOR (a headless pi
// that breaks work down and proposes tasks), which leads; on the right, the PLAN of the
// conversation it is in — its tasks as a DAG, with the selected node's detail. Nothing runs
// until the user approves a task or the whole plan; approved tasks then start as their
// dependencies finish, each as its own pi WORKER in a herdr pane (which the user can also
// watch or take over from a terminal), and the coordinator reviews each one to done.
//
// The renderer holds no capability here: every action is a named IPC call carrying an opaque
// task/folder id or bounded text, and folders are granted through main's own picker dialog.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { disabledOpacity, token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useI18n, useT, type Locale, type TranslateFn } from '../../i18n';
import { useWorkbench } from '../../hooks/useWorkbench';
import {
  abortChat,
  deleteConversation,
  openConversation,
  resetChat,
  sendChat,
  startWorkbench,
  stopWorkbench,
} from '../../lib/workbenchStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { workbenchErrorMessage } from './errors';
import {
  WORKBENCH_LIMITS,
  isLiveTaskStatus,
  type ChatItem,
  type ConversationView,
  type TaskView,
  type WorkbenchSnapshot,
} from '../../../shared/workbench';
import { PlanPanel } from './PlanPanel';
import { ProposalCard } from './ProposalCard';
import { WorkbenchTopBar } from './WorkbenchTopBar';
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
            left={
              <ChatPane
                wb={wb}
                t={t}
                run={run}
                busy={busy}
                onToggle={() => void toggle()}
                onSelectTask={setSelectedTaskId}
              />
            }
            right={
              <PlanPanel wb={wb} t={t} run={run} selectedId={selectedTaskId} onSelectTask={setSelectedTaskId} />
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
  onSelectTask,
}: {
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
  busy: boolean;
  onToggle: () => void;
  onSelectTask: (id: string) => void;
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
            opacity: toggleDisabled ? disabledOpacity : 1,
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
          style={{ ...actionButtonStyle, opacity: canSwitch ? 1 : disabledOpacity }}
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
        {wb.chat.map((item) =>
          item.kind === 'proposal' ? (
            <ProposalCard key={item.id} taskIds={item.taskIds} wb={wb} t={t} run={run} onSelectTask={onSelectTask} />
          ) : (
            <ChatEntry key={item.id} item={item} tasks={wb.tasks} t={t} />
          ),
        )}
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
    case 'proposal':
      // Drawn by ChatPane as a ProposalCard (it needs the board and the runner).
      return null;
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
                    opacity: canSwitch || c.current ? 1 : disabledOpacity,
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
