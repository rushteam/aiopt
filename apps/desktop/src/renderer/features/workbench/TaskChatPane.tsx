import { useEffect, useMemo, useState } from 'react';
import { token, fontSize, space } from '../../themes/tokens';
import type { TranslateFn } from '../../i18n';
import {
  WORKBENCH_LIMITS,
  isLiveTaskStatus,
  taskAllows,
  type TaskView,
  type WorkbenchSnapshot,
} from '../../../shared/workbench';
import { messageTask, readTaskOutput } from '../../lib/workbenchStore';
import { WorkbenchChatComposer, WorkbenchChatThread, type WorkbenchChatLine } from './workbenchChat';

const OUTPUT_POLL_MS = 2000;

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
  const [liveOutput, setLiveOutput] = useState<string | null>(null);
  const live = isLiveTaskStatus(task.status);
  const canMessage = taskAllows('message', task.status);
  const ready = wb.status === 'ready' && wb.herdrAvailable;

  useEffect(() => {
    if (!live || !task.agentName) {
      setLiveOutput(null);
      return;
    }
    let alive = true;
    const read = (): void => {
      void readTaskOutput(task.id)
        .then((text) => {
          if (alive) setLiveOutput(text);
        })
        .catch(() => {
          if (alive) setLiveOutput('');
        });
    };
    read();
    const timer = setInterval(read, OUTPUT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [task.id, task.agentName, live]);

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
    const text = draft.trim();
    if (!text || !canMessage) return;
    if (await run(() => messageTask(task.id, text))) setDraft('');
  };

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
      <div style={{ flexShrink: 0 }}>
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
        />
      </div>
    </section>
  );
}
