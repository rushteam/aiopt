// Workbench — a multi-agent work assistant built from pi + herdr (see shared/workbench.ts).
//
// Two panes under one status bar: on the left, the chat with the COORDINATOR (a headless pi
// that breaks work down and proposes tasks); on the right, the task board. A proposed task
// runs only when the user picks a folder and presses Run; it then runs as its own pi WORKER in
// a herdr pane, which the user can also watch or take over from a terminal.
//
// The renderer holds no capability here: every action is a named IPC call carrying an opaque
// task/folder id or bounded text, and folders are granted through main's own picker dialog.

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useI18n, useT, type Locale, type TranslateFn } from '../../i18n';
import { useWorkbench } from '../../hooks/useWorkbench';
import {
  abortChat,
  addFolder,
  completeTask,
  createTask,
  deleteConversation,
  launchTask,
  messageTask,
  openConversation,
  readTaskOutput,
  removeFolder,
  removeTask,
  resetChat,
  runAllTasks,
  sendChat,
  startWorkbench,
  stopTask,
  stopWorkbench,
  updateTask,
  installHerdr,
  updateWorkbenchSettings,
} from '../../lib/workbenchStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
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
  pendingDependencies,
  taskDependenciesMet,
} from '../../../shared/workbench';

/** How often an open output panel re-reads the worker's terminal. */
const OUTPUT_POLL_MS = 2000;

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
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Visually hidden — the tab already names the screen. See ProvidersHome. */}
      <h1 className="sr-only">{t('workbench.title')}</h1>
      <div style={{ padding: '16px 24px 0', display: 'flex', flexDirection: 'column', gap: space.lg }}>
        <StatusBar wb={wb} t={t} busy={busy} run={run} onToggle={() => void toggle()} />
        <FolderStrip folders={wb.folders} t={t} run={run} />
        {error && (
          <p role="alert" style={{ margin: 0, color: token('danger'), fontSize: fontSize.base }}>
            {error}
          </p>
        )}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: space.xl,
          padding: '16px 24px 24px',
        }}
      >
        <ChatPane wb={wb} t={t} run={run} />
        <TaskBoard wb={wb} t={t} run={run} liveCount={liveCount} />
      </div>
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

// ─── Status bar ──────────────────────────────────────────────────────────────

function StatusBar({
  wb,
  t,
  busy,
  run,
  onToggle,
}: {
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  busy: boolean;
  run: Runner;
  onToggle: () => void;
}) {
  const probe = wb.herdrProbe;
  const showInstall = !probe.remote && !probe.installed && wb.status !== 'error';
  const tasksBlocked =
    (wb.status === 'ready' && !wb.herdrAvailable) || (!probe.installed && wb.status === 'stopped');
  const on = wb.status === 'ready' || wb.status === 'starting';
  const dot =
    wb.status === 'ready' ? token('success') : wb.status === 'error' ? token('danger') : token('borderStrong');
  return (
    <section style={{ ...panelStyle, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: space.sm }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.lg, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: space.sm, fontSize: fontSize.md, fontWeight: 600 }}>
          <span aria-hidden style={{ ...dotStyle, background: dot }} />
          {t(`workbench.status.${wb.status}`)}
        </span>
        {wb.model && (
          <span style={{ fontSize: fontSize.base, color: token('textMuted'), minWidth: 0 }}>
            {t('workbench.model')}{' '}
            <span style={{ color: token('text') }}>
              {wb.model.providerName} / {wb.model.modelId}
            </span>{' '}
            · {wb.model.proxied ? t('workbench.proxied') : t('workbench.direct')}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          {...(on
            ? hoverBackground('transparent', token('surfaceHover'))
            : hoverBackground(token('accent'), token('accentHover')))}
          style={{ ...(on ? ghostStyle : accentStyle), opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}
        >
          {on ? t('workbench.stop') : t('workbench.start')}
        </button>
      </div>
      {wb.status === 'stopped' && (
        <p style={{ margin: 0, fontSize: fontSize.base, color: token('textMuted') }}>{t('workbench.subtitle')}</p>
      )}
      {wb.issue && (
        <p style={{ margin: 0, fontSize: fontSize.base, color: token('danger') }}>{t(`workbench.issue.${wb.issue}`)}</p>
      )}
      {(probe.installed || probe.installing || showInstall) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.md }}>
          <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>
            {probe.remote
              ? t('workbench.herdr.remote').replace('{{target}}', probe.displayPath ?? '')
              : probe.installed
                ? t('workbench.herdr.local')
                    .replace('{{version}}', probe.version ?? '—')
                    .replace('{{path}}', probe.displayPath ?? '')
                : t('workbench.herdr.notFound')}
          </span>
          {showInstall && (
            <button
              type="button"
              disabled={probe.installing || busy}
              onClick={() => void run(installHerdr)}
              {...hoverBackground(token('accent'), token('accentHover'))}
              style={{ ...accentStyle, fontSize: fontSize.sm, padding: '4px 10px', opacity: probe.installing ? 0.6 : 1 }}
            >
              {probe.installing ? t('workbench.herdr.installing') : t('workbench.herdr.install')}
            </button>
          )}
        </div>
      )}
      {tasksBlocked && wb.status !== 'starting' && (
        <p style={{ margin: 0, fontSize: fontSize.base, color: token('textMuted') }}>{t('workbench.herdrMissing')}</p>
      )}
      {wb.status === 'ready' && wb.herdrAvailable && (
        <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted') }}>
          {t('workbench.attachHint')}{' '}
          <code style={codeStyle}>
            {probe.remote ? `ssh ${wb.settings.herdrSshTarget} herdr --session ${wb.herdrSession}` : `herdr --session ${wb.herdrSession}`}
          </code>
        </p>
      )}
    </section>
  );
}

// ─── Folders ─────────────────────────────────────────────────────────────────

function FolderStrip({ folders, t, run }: { folders: readonly FolderView[]; t: TranslateFn; run: Runner }) {
  return (
    <section aria-label={t('workbench.folders.label')} style={{ display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'wrap' }}>
      <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: token('textMuted') }}>{t('workbench.folders.label')}</span>
      {folders.length === 0 && (
        <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>{t('workbench.folders.empty')}</span>
      )}
      {folders.map((f) => (
        <span
          key={f.id}
          title={f.displayPath}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: space.xs,
            maxWidth: 260,
            padding: '2px 4px 2px 10px',
            borderRadius: radius.pill,
            border: `1px solid ${token('border')}`,
            background: token('surface'),
            fontSize: fontSize.sm,
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
          {f.isGitRepo && <span style={{ color: token('textMuted') }}>{t('workbench.folders.git')}</span>}
          <button
            type="button"
            aria-label={`${t('workbench.folders.remove')}: ${f.name}`}
            title={t('workbench.folders.remove')}
            onClick={() => void run(() => removeFolder(f.id))}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={chipCloseStyle}
          >
            ×
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => void run(addFolder)}
        disabled={folders.length >= WORKBENCH_LIMITS.folders}
        {...hoverBackground('transparent', token('surfaceHover'))}
        style={smallGhostStyle}
      >
        {t('workbench.folders.add')}
      </button>
      <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>{t('workbench.folders.hint')}</span>
    </section>
  );
}

// ─── Chat ────────────────────────────────────────────────────────────────────

function ChatPane({ wb, t, run }: { wb: WorkbenchSnapshot; t: TranslateFn; run: Runner }) {
  const [draft, setDraft] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const ready = wb.status === 'ready';
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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter is a newline; an IME composition's Enter is left alone.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <section aria-label={t('workbench.chat.title')} style={{ ...panelStyle, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={paneHeaderStyle}>
        <h2 style={paneTitleStyle}>{t('workbench.chat.title')}</h2>
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
        aria-live="polite"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: space.lg, display: 'flex', flexDirection: 'column', gap: space.lg }}
      >
        {wb.chat.length === 0 && (
          <p style={{ margin: 'auto 0', textAlign: 'center', fontSize: fontSize.base, color: token('textMuted') }}>
            {ready ? t('workbench.chat.empty') : t('workbench.chat.notRunning')}
          </p>
        )}
        {wb.chat.map((item) => (
          <ChatEntry key={item.id} item={item} t={t} />
        ))}
      </div>
      <div style={{ borderTop: `1px solid ${token('border')}`, padding: space.lg, display: 'flex', flexDirection: 'column', gap: space.sm }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!ready}
          maxLength={WORKBENCH_LIMITS.chatText}
          rows={3}
          placeholder={t('workbench.chat.placeholder')}
          aria-label={t('workbench.chat.placeholder')}
          style={{ ...inputStyle, resize: 'none', fontFamily: 'inherit', opacity: ready ? 1 : 0.5 }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: space.md }}>
          <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>{t('workbench.chat.sendHint')}</span>
          <span style={{ flex: 1 }} />
          {wb.streaming && (
            <button
              type="button"
              onClick={() => void run(abortChat)}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={smallGhostStyle}
            >
              {t('workbench.chat.abort')}
            </button>
          )}
          <button
            type="button"
            onClick={() => void send()}
            disabled={!ready || draft.trim() === ''}
            {...hoverBackground(token('accent'), token('accentHover'))}
            style={{ ...smallAccentStyle, opacity: !ready || draft.trim() === '' ? 0.5 : 1 }}
          >
            {t('workbench.chat.send')}
          </button>
        </div>
      </div>
    </section>
  );
}

function ChatEntry({ item, t }: { item: ChatItem; t: TranslateFn }) {
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
            {item.text}
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
      style={{ borderBottom: `1px solid ${token('border')}`, background: token('surface'), maxHeight: 260, overflowY: 'auto' }}
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
}: {
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
  liveCount: number;
}) {
  const [creating, setCreating] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [sshDraft, setSshDraft] = useState(wb.settings.herdrSshTarget ?? '');
  useEffect(() => {
    setSshDraft(wb.settings.herdrSshTarget ?? '');
  }, [wb.settings.herdrSshTarget]);
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
  const setSetting = (patch: {
    autoRun?: boolean;
    notifyCoordinator?: boolean;
    autoLaunchDependents?: boolean;
    herdrSshTarget?: string | null;
  }): void => {
    setSavingSettings(true);
    void run(() => updateWorkbenchSettings(patch)).finally(() => setSavingSettings(false));
  };

  return (
    <section aria-label={t('workbench.tasks.title')} style={{ ...panelStyle, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={paneHeaderStyle}>
        <h2 style={paneTitleStyle}>{t('workbench.tasks.title')}</h2>
        <span style={{ fontSize: fontSize.sm, color: token('textMuted'), fontVariantNumeric: 'tabular-nums' }}>
          {t('workbench.tasks.running')} {liveCount}/{WORKBENCH_LIMITS.liveTasks}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void run(runAllTasks)}
          disabled={!canRun || runnable === 0}
          title={t('workbench.tasks.runAllHint')}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={{ ...actionButtonStyle, opacity: canRun && runnable > 0 ? 1 : 0.5 }}
        >
          {t('workbench.tasks.runAll')}
          {runnable > 0 && (
            <span style={{ marginLeft: space.xs, color: token('textMuted'), fontVariantNumeric: 'tabular-nums' }}>{runnable}</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={creating || full}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={{ ...actionButtonStyle, opacity: creating || full ? 0.5 : 1 }}
        >
          {t('workbench.tasks.new')}
        </button>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: space.lg,
          flexWrap: 'wrap',
          padding: '6px 12px',
          borderBottom: `1px solid ${token('border')}`,
        }}
      >
        <SettingToggle
          label={t('workbench.tasks.autoRun')}
          hint={t('workbench.tasks.autoRunHint')}
          checked={wb.settings.autoRun}
          disabled={savingSettings}
          onChange={(autoRun) => setSetting({ autoRun })}
        />
        <SettingToggle
          label={t('workbench.tasks.notify')}
          hint={t('workbench.tasks.notifyHint')}
          checked={wb.settings.notifyCoordinator}
          disabled={savingSettings}
          onChange={(notifyCoordinator) => setSetting({ notifyCoordinator })}
        />
        <SettingToggle
          label={t('workbench.tasks.autoLaunchDependents')}
          hint={t('workbench.tasks.autoLaunchDependentsHint')}
          checked={wb.settings.autoLaunchDependents}
          disabled={savingSettings}
          onChange={(autoLaunchDependents) => setSetting({ autoLaunchDependents })}
        />
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: fontSize.sm, color: token('textMuted') }}>
          {t('workbench.herdr.sshLabel')}
          <input
            type="text"
            value={sshDraft}
            disabled={savingSettings || wb.status === 'starting'}
            placeholder={t('workbench.herdr.sshPlaceholder')}
            onChange={(e) => setSshDraft(e.target.value)}
            onBlur={() => {
              const trimmed = sshDraft.trim();
              const next = trimmed === '' ? null : trimmed;
              if (next === wb.settings.herdrSshTarget) return;
              setSetting({ herdrSshTarget: next });
            }}
            style={{
              minWidth: 180,
              maxWidth: 280,
              padding: '4px 8px',
              borderRadius: radius.sm,
              border: `1px solid ${token('border')}`,
              background: token('surface'),
              color: token('text'),
              fontSize: fontSize.sm,
            }}
          />
          <span style={{ fontSize: fontSize.xs }}>{t('workbench.herdr.sshHint')}</span>
        </label>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: space.lg, display: 'flex', flexDirection: 'column', gap: space.lg }}>
        {creating && (
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
        )}
        {tasks.length === 0 && !creating && (
          <p style={{ margin: 'auto 0', textAlign: 'center', fontSize: fontSize.base, color: token('textMuted') }}>
            {t('workbench.tasks.empty')}
          </p>
        )}
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            wb={wb}
            t={t}
            run={run}
            canLaunch={canRun}
          />
        ))}
      </div>
    </section>
  );
}

/** A persisted workbench preference; the hint explains it on hover and to screen readers. */
function SettingToggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label title={hint} style={{ display: 'inline-flex', alignItems: 'center', gap: space.sm, fontSize: fontSize.sm, color: token('text') }}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-description={hint} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
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
        <select
          value={folder?.id ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const next = folders.find((f) => f.id === e.target.value) ?? null;
            onChange(next?.id ?? null, next?.isGitRepo ? isolated : false);
          }}
          style={{ ...inputStyle, padding: '4px 8px', fontSize: fontSize.sm, maxWidth: 220 }}
        >
          <option value="">{t('workbench.tasks.noFolder')}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <label
        title={canIsolate ? undefined : t('workbench.tasks.isolatedUnavailable')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: space.sm,
          fontSize: fontSize.sm,
          color: canIsolate ? token('text') : token('textMuted'),
        }}
      >
        <input
          type="checkbox"
          checked={isolated && canIsolate}
          disabled={disabled || !canIsolate}
          onChange={(e) => onChange(folderId, e.target.checked)}
        />
        {t('workbench.tasks.isolated')}
      </label>
    </div>
  );
}

function TaskCard({
  task,
  wb,
  t,
  run,
  canLaunch,
}: {
  task: TaskView;
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
  canLaunch: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const [reply, setReply] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const folder = wb.folders.find((f) => f.id === task.folderId) ?? null;
  const live = isLiveTaskStatus(task.status);
  // Once a worktree exists, relaunch reuses that checkout, so the place is fixed.
  const placeLocked = task.worktreeDisplay !== null;
  const editable = taskAllows('edit', task.status);
  const depsReady = taskDependenciesMet(task, wb.tasks);
  const waitingOn = pendingDependencies(task, wb.tasks);
  const launchable = taskAllows('launch', task.status) && canLaunch && folder !== null && depsReady;

  if (editing) {
    return (
      <TaskForm
        t={t}
        folders={wb.folders}
        submitLabel={t('workbench.tasks.save')}
        lockPlace={placeLocked}
        initial={{ title: task.title, prompt: task.prompt, folderId: task.folderId, isolated: task.isolated }}
        onCancel={() => setEditing(false)}
        onSubmit={async (draft) => {
          const ok = await run(() =>
            updateTask(
              placeLocked
                ? { taskId: task.id, title: draft.title, prompt: draft.prompt }
                : { taskId: task.id, ...draft },
            ),
          );
          if (ok) setEditing(false);
        }}
      />
    );
  }

  const sendReply = async (): Promise<void> => {
    const text = reply.trim();
    if (!text) return;
    if (await run(() => messageTask(task.id, text))) setReply('');
  };

  const meta = [
    folder?.name ?? (task.folderId ? t('workbench.tasks.folderGone') : null),
    task.branch,
    t(task.origin === 'orchestrator' ? 'workbench.tasks.fromCoordinator' : 'workbench.tasks.fromYou'),
  ].filter((part): part is string => part !== null);

  return (
    <article style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: space.md }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: space.md }}>
        <h3 style={{ margin: 0, flex: 1, minWidth: 0, fontSize: fontSize.md, fontWeight: 600, overflowWrap: 'anywhere' }}>
          {task.title}
        </h3>
        <StatusLabel status={task.status} t={t} />
      </div>
      <div style={{ fontSize: fontSize.sm, color: token('textMuted'), overflowWrap: 'anywhere' }}>{meta.join(' · ')}</div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        style={{
          all: 'unset',
          cursor: 'pointer',
          fontSize: fontSize.base,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          ...(expanded
            ? {}
            : { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
        }}
      >
        {task.prompt}
      </button>
      {task.failure && (
        <p style={{ margin: 0, fontSize: fontSize.sm, color: token('danger') }}>{t(`workbench.failure.${task.failure}`)}</p>
      )}
      {waitingOn.length > 0 && (
        <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted') }}>
          {t('workbench.tasks.waitingOn')} {waitingOn.map((d) => d.title).join(', ')}
        </p>
      )}
      {editable && !placeLocked && (
        <PlacePicker
          t={t}
          folders={wb.folders}
          folderId={task.folderId}
          isolated={task.isolated}
          onChange={(folderId, isolated) => void run(() => updateTask({ taskId: task.id, folderId, isolated }))}
        />
      )}
      {placeLocked && task.worktreeDisplay && (
        <div style={{ fontSize: fontSize.sm, color: token('textMuted'), overflowWrap: 'anywhere' }}>
          {t('workbench.tasks.worktree')} <code style={codeStyle}>{task.worktreeDisplay}</code>
        </div>
      )}
      {live && task.agentName && (
        <div style={{ fontSize: fontSize.sm, color: token('textMuted'), overflowWrap: 'anywhere' }}>
          {t('workbench.tasks.attach')}{' '}
          <code style={codeStyle}>
            herdr --session {wb.herdrSession} agent attach {task.agentName}
          </code>
        </div>
      )}
      {taskAllows('message', task.status) && (
        <div style={{ display: 'flex', gap: space.md }}>
          <input
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void sendReply();
              }
            }}
            maxLength={WORKBENCH_LIMITS.chatText}
            placeholder={t('workbench.actions.messagePlaceholder')}
            aria-label={t('workbench.actions.messagePlaceholder')}
            style={{ ...inputStyle, flex: 1, minWidth: 0, padding: '4px 8px', fontSize: fontSize.sm }}
          />
          <button
            type="button"
            onClick={() => void sendReply()}
            disabled={reply.trim() === ''}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={{ ...actionButtonStyle, opacity: reply.trim() === '' ? 0.5 : 1 }}
          >
            {t('workbench.actions.message')}
          </button>
        </div>
      )}
      <div style={{ display: 'flex', gap: space.md, flexWrap: 'wrap' }}>
        {taskAllows('launch', task.status) && (
          <button
            type="button"
            onClick={() => void run(() => launchTask(task.id))}
            disabled={!launchable}
            title={folder === null ? t('workbench.tasks.needFolder') : undefined}
            {...hoverBackground(token('accent'), token('accentHover'))}
            style={{ ...smallAccentStyle, opacity: launchable ? 1 : 0.5, cursor: launchable ? 'pointer' : 'default' }}
          >
            {task.status === 'proposed' ? t('workbench.actions.launch') : t('workbench.actions.relaunch')}
          </button>
        )}
        {editable && (
          <button type="button" onClick={() => setEditing(true)} {...hoverBackground('transparent', token('surfaceHover'))} style={actionButtonStyle}>
            {t('workbench.actions.edit')}
          </button>
        )}
        {taskAllows('complete', task.status) && (
          <button
            type="button"
            onClick={() => void run(() => completeTask(task.id))}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={actionButtonStyle}
          >
            {t('workbench.actions.complete')}
          </button>
        )}
        {live && task.status !== 'starting' && (
          <button
            type="button"
            onClick={() => setShowOutput(!showOutput)}
            aria-expanded={showOutput}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={actionButtonStyle}
          >
            {showOutput ? t('workbench.actions.hideOutput') : t('workbench.actions.showOutput')}
          </button>
        )}
        <span style={{ flex: 1 }} />
        {taskAllows('stop', task.status) && (
          <button
            type="button"
            onClick={() => void run(() => stopTask(task.id))}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={dangerActionButtonStyle}
          >
            {t('workbench.actions.stop')}
          </button>
        )}
        {taskAllows('remove', task.status) && (
          <button
            type="button"
            onClick={() => (task.worktreeDisplay ? setConfirmRemove(true) : void run(() => removeTask(task.id)))}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={dangerActionButtonStyle}
          >
            {t('workbench.actions.remove')}
          </button>
        )}
      </div>
      {showOutput && live && <TaskOutputPanel taskId={task.id} t={t} />}
      {confirmRemove && (
        <ConfirmDialog
          title={t('workbench.removeConfirm')}
          message={task.branch ? `${t('workbench.tasks.branch')} ${task.branch}` : undefined}
          confirmLabel={t('workbench.removeConfirmYes')}
          cancelLabel={t('workbench.cancel')}
          danger
          onConfirm={() => {
            setConfirmRemove(false);
            void run(() => removeTask(task.id));
          }}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </article>
  );
}

function StatusLabel({ status, t }: { status: TaskStatus; t: TranslateFn }) {
  // Color rides on the dot only; the label stays in a text token so it reads in both modes.
  const dot =
    status === 'working' || status === 'starting'
      ? token('accent')
      : status === 'blocked' || status === 'failed'
        ? token('danger')
        : status === 'review' || status === 'done'
          ? token('success')
          : token('borderStrong');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: space.xs, flexShrink: 0, fontSize: fontSize.sm, color: token('textMuted') }}>
      <span aria-hidden style={{ ...dotStyle, background: dot }} />
      {t(`workbench.taskStatus.${status}`)}
    </span>
  );
}

function TaskOutputPanel({ taskId, t }: { taskId: string; t: TranslateFn }) {
  const [text, setText] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const read = (): void => {
      readTaskOutput(taskId)
        .then((next) => {
          if (alive) setText(next);
        })
        .catch(() => {
          if (alive) setText('');
        });
    };
    read();
    const timer = setInterval(read, OUTPUT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [taskId]);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div ref={ref} style={{ ...preStyle, maxHeight: 220, overflowY: 'auto' }}>
      {text === null ? t('workbench.output.loading') : text === '' ? t('workbench.output.empty') : text}
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
};

const paneTitleStyle: CSSProperties = { margin: 0, fontSize: fontSize.lg, fontWeight: 600 };

const dotStyle: CSSProperties = { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 };

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

const accentStyle: CSSProperties = {
  padding: '6px 16px',
  borderRadius: radius.md,
  border: `1px solid ${token('accent')}`,
  background: token('accent'),
  color: token('accentText'),
  fontSize: fontSize.md,
};

const ghostStyle: CSSProperties = {
  padding: '6px 16px',
  borderRadius: radius.md,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
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
