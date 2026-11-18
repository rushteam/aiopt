// A task's chat with its worker. A local worker's own pi session file gives the real chat
// (messages, thinking, tool calls) rendered like the coordinator's; the worker's terminal stays
// one toggle away. A task without a readable session (an SSH worker, or one launched before
// task sessions) shows its prompt, follow-ups and terminal text as before.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { token, fontSize, space } from '../../themes/tokens';
import type { TranslateFn } from '../../i18n';
import {
  WORKBENCH_LIMITS,
  isLiveTaskStatus,
  taskAllows,
  type ChatItem,
  type TaskView,
  type WorkbenchSnapshot,
} from '../../../shared/workbench';
import { messageTask, readTaskOutput } from '../../lib/workbenchStore';
import { segmentButtonChrome, segmentedRootStyle } from '../../components/ui/controlStyles';
import { VirtualChatList } from '../../components/ui/VirtualChatList';
import {
  ChatColumn,
  ChatEmptyState,
  ChatLoadingIndicator,
  useComposerBlocks,
  WorkbenchChatComposer,
  WorkbenchChatThread,
  type WorkbenchChatLine,
} from './workbenchChat';
import { ChatEntry, estimateChatItemHeight } from './ChatEntry';
import { useMentionSource } from './mentionPicker';
import { WriteRequestCards } from './WriteRequestCard';
import type { DraggedEntry } from './entryDrag';
import { folderMentionText } from './workbenchNav';

const OUTPUT_POLL_MS = 2000;

type ChatView = 'chat' | 'terminal';

export function TaskChatPane({
  task,
  wb,
  t,
  run,
}: {
  task: TaskView;
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: (action: () => Promise<void>) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState('');
  // No @task: a worker gets @session excerpts attached, but has no board to resolve @task.
  const mentions = useMentionSource(t, [], wb.folders, { skills: wb.skills });
  const blocks = useComposerBlocks(t);
  const dropEntry = (entry: DraggedEntry): void => {
    const folder = wb.folders.find((f) => f.id === entry.folderId);
    if (!folder) return;
    blocks.addRef(folderMentionText(folder.name, entry.relPath));
  };
  const [liveOutput, setLiveOutput] = useState<string | null>(null);
  /** The worker chat from its session file; null until read, or when the task has none. */
  const [items, setItems] = useState<ChatItem[] | null>(null);
  const [view, setView] = useState<ChatView>('chat');
  const live = isLiveTaskStatus(task.status);
  const canMessage = taskAllows('message', task.status);
  const ready = wb.status === 'ready' && wb.herdrAvailable;

  // Polled while the worker runs; read once otherwise (a finished task keeps its chat).
  useEffect(() => {
    setItems(null);
    setLiveOutput(null);
  }, [task.id]);
  useEffect(() => {
    const polling = live && !!task.agentName;
    let alive = true;
    const read = (): void => {
      void readTaskOutput(task.id)
        .then((out) => {
          if (!alive) return;
          setItems((prev) => sameItems(prev, out.items));
          setLiveOutput(polling ? out.text : null);
        })
        .catch(() => {
          if (alive && polling) setLiveOutput('');
        });
    };
    read();
    if (!polling) return () => void (alive = false);
    const timer = setInterval(read, OUTPUT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [task.id, task.agentName, live, task.status]);

  const lines = useMemo((): WorkbenchChatLine[] => {
    const out: WorkbenchChatLine[] = [
      { id: `${task.id}-prompt`, role: 'user', text: task.prompt },
      ...task.thread.map((m, i) => ({ id: `${task.id}-u-${i}-${m.at}`, role: 'user' as const, text: m.text })),
    ];
    const assistantText = live ? liveOutput : task.workerOutput;
    if (assistantText && assistantText.trim() !== '') {
      out.push({ id: `${task.id}-worker`, role: 'assistant', text: assistantText.trim() });
    }
    return out;
  }, [task, live, liveOutput]);

  const send = async (): Promise<void> => {
    const text = blocks.compose(draft);
    if (!text || !canMessage || text.length > WORKBENCH_LIMITS.taskPrompt) return;
    if (await run(() => messageTask(task.id, text))) {
      setDraft('');
      blocks.reset();
    }
  };

  const renderItem = useCallback(
    (item: ChatItem) => (
      <ChatColumn>
        <ChatEntry item={item} tasks={wb.tasks} t={t} />
      </ChatColumn>
    ),
    [wb.tasks, t],
  );

  const terminalText = (live ? liveOutput : task.workerOutput) ?? '';
  const structured = items !== null;
  const shownView: ChatView = structured ? view : 'chat';
  // The session file gets a message once pi finishes it: while the worker runs, say so.
  const working = task.status === 'working' || task.status === 'starting';

  return (
    <section
      aria-label={t('workbench.taskChat.title')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        flex: 1,
      }}
    >
      {structured && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: `${space.sm}px ${space.md}px 0` }}>
          <ViewToggle view={view} onChange={setView} t={t} />
        </div>
      )}
      {shownView === 'terminal' ? (
        <pre style={terminalStyle} aria-label={t('workbench.taskChat.viewTerminal')}>
          {terminalText.trim() === '' ? (
            <span style={{ color: token('textMuted'), fontFamily: 'inherit' }}>
              {t('workbench.taskChat.terminalEmpty')}
            </span>
          ) : (
            terminalText
          )}
        </pre>
      ) : structured ? (
        <VirtualChatList
          items={items}
          getKey={itemKey}
          renderItem={renderItem}
          estimateHeight={estimateChatItemHeight}
          followSignal={task.id}
          gap={space.xl}
          padding={space.xl}
          jumpLabel={t('workbench.chat.jumpToLatest')}
          loadingLabel={t('workbench.chat.loadingOlder')}
          footer={
            working ? (
              <ChatColumn>
                <ChatLoadingIndicator label={t('workbench.chat.working')} />
              </ChatColumn>
            ) : undefined
          }
          empty={<ChatEmptyState body={t('workbench.taskChat.empty')} />}
        />
      ) : (
        <WorkbenchChatThread
          lines={lines}
          empty={t('workbench.taskChat.empty')}
          t={t}
          footer={
            live && liveOutput === null ? (
              <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted') }}>{t('workbench.output.loading')}</p>
            ) : undefined
          }
        />
      )}
      <div style={{ flexShrink: 0 }}>
        <WriteRequestCards requests={wb.pendingWrites.filter((r) => r.taskId === task.id)} tasks={wb.tasks} t={t} run={run} />
        <WorkbenchChatComposer
          draft={draft}
          setDraft={setDraft}
          onSend={() => void send()}
          disabled={!ready || !canMessage}
          maxLength={WORKBENCH_LIMITS.taskPrompt}
          placeholder={
            !ready
              ? t('workbench.chat.notRunning')
              : canMessage
                ? t('workbench.taskChat.placeholder')
                : t('workbench.taskChat.waitLaunch')
          }
          sendHint={t('workbench.chat.sendHint')}
          sendLabel={t('workbench.chat.send')}
          rows={3}
          onEntryDrop={dropEntry}
          entryDropHint={t('workbench.chat.entryDrop')}
          mentions={mentions}
          blocks={blocks}
        />
      </div>
    </section>
  );
}

const itemKey = (item: ChatItem): string => item.id;

/** The previous items while the new ones are equal, so a poll that changed nothing re-renders nothing. */
function sameItems(prev: ChatItem[] | null, next: ChatItem[] | null): ChatItem[] | null {
  if (prev === next || (prev && next && JSON.stringify(prev) === JSON.stringify(next))) return prev;
  return next;
}

function ViewToggle({ view, onChange, t }: { view: ChatView; onChange: (v: ChatView) => void; t: TranslateFn }) {
  return (
    <div role="group" aria-label={t('workbench.taskChat.viewMode')} style={{ ...segmentedRootStyle, flexShrink: 0 }}>
      {(['chat', 'terminal'] as const).map((v, index) => {
        const active = view === v;
        return (
          <button
            key={v}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(v)}
            style={{
              ...segmentButtonChrome('sm'),
              fontSize: fontSize.xs,
              borderLeft: index === 0 ? 'none' : `1px solid ${token('border')}`,
              background: active ? token('accent') : 'transparent',
              color: active ? token('accentText') : token('text'),
              cursor: active ? 'default' : 'pointer',
            }}
          >
            {t(v === 'chat' ? 'workbench.taskChat.viewChat' : 'workbench.taskChat.viewTerminal')}
          </button>
        );
      })}
    </div>
  );
}

const terminalStyle = {
  flex: 1,
  minHeight: 0,
  margin: 0,
  padding: space.xl,
  overflow: 'auto',
  fontFamily: 'ui-monospace, monospace',
  fontSize: fontSize.xs,
  lineHeight: 1.5,
  color: token('text'),
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
} as const;
