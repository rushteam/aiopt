// A worker's `write` / `edit` outside the workbench folders, held until the user answers
// (main/workbench/writeGate.ts). The coordinator chat lists every waiting request above its
// composer; a task's own chat lists that task's. Answering sends the request id only: main
// accepts one answer, for a request it is still holding, and treats no answer as "deny".

import type { CSSProperties } from 'react';
import { fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { decideWrite } from '../../lib/workbenchStore';
import { ChatColumn } from './workbenchChat';
import type { PendingWriteView, TaskView } from '../../../shared/workbench';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export function WriteRequestCards({
  requests,
  tasks,
  t,
  run,
  onSelectTask,
}: {
  requests: readonly PendingWriteView[];
  tasks: readonly TaskView[];
  t: TranslateFn;
  run: Runner;
  /** Present: the task title opens the task (the coordinator chat lists several tasks). */
  onSelectTask?: (id: string) => void;
}) {
  if (requests.length === 0) return null;
  return (
    <div style={{ padding: `${space.xs}px ${space.lg}px 0` }}>
      <ChatColumn style={{ gap: space.sm }}>
        {requests.map((req) => (
          <WriteRequestCard
            key={req.id}
            req={req}
            task={tasks.find((task) => task.id === req.taskId) ?? null}
            t={t}
            run={run}
            onSelectTask={onSelectTask}
          />
        ))}
      </ChatColumn>
    </div>
  );
}

function WriteRequestCard({
  req,
  task,
  t,
  run,
  onSelectTask,
}: {
  req: PendingWriteView;
  task: TaskView | null;
  t: TranslateFn;
  run: Runner;
  onSelectTask?: (id: string) => void;
}) {
  const title = task?.title ?? '';
  const [before, after = ''] = t(
    req.tool === 'edit' ? 'workbench.writeGate.editMessage' : 'workbench.writeGate.writeMessage',
  ).split('{{task}}');
  return (
    <div role="alertdialog" aria-label={t('workbench.writeGate.title')} style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, minWidth: 0 }}>
        <ShieldIcon />
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: token('text') }}>
          {t('workbench.writeGate.title')}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: fontSize.sm, color: token('text'), overflowWrap: 'anywhere' }}>
        {before}
        {onSelectTask && task ? (
          <button
            type="button"
            onClick={() => onSelectTask(task.id)}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={taskButtonStyle}
          >
            {title}
          </button>
        ) : (
          <strong style={{ fontWeight: 600 }}>{title}</strong>
        )}
        {after}
      </p>
      <code style={pathStyle}>{req.path}</code>
      <p style={{ margin: 0, fontSize: fontSize.xs, color: token('textMuted') }}>{t('workbench.writeGate.note')}</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: space.sm }}>
        <button
          type="button"
          onClick={() => void run(() => decideWrite(req.id, false))}
          {...hoverBackground(token('surface'), token('surfaceHover'))}
          style={secondaryButtonStyle}
        >
          {t('workbench.writeGate.deny')}
        </button>
        <button
          type="button"
          onClick={() => void run(() => decideWrite(req.id, true))}
          {...hoverBackground(token('accent'), token('accentHover'))}
          style={accentButtonStyle}
        >
          {t('workbench.writeGate.allow')}
        </button>
      </div>
    </div>
  );
}

function ShieldIcon() {
  return (
    <svg
      aria-hidden
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke={token('warning')}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d="M8 1.5 2.5 3.5v4c0 3.2 2.3 5.9 5.5 7 3.2-1.1 5.5-3.8 5.5-7v-4L8 1.5Z" />
      <path d="M8 5.5v3" />
      <path d="M8 10.75v.25" />
    </svg>
  );
}

const cardStyle: CSSProperties = {
  border: `1px solid ${token('warning')}`,
  borderRadius: radius.md,
  background: token('surface'),
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: space.sm,
};

const pathStyle: CSSProperties = {
  display: 'block',
  fontFamily: MONO,
  fontSize: fontSize.sm,
  color: token('text'),
  background: token('bg'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.sm,
  padding: '4px 8px',
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
};

const taskButtonStyle: CSSProperties = {
  display: 'inline',
  padding: '0 2px',
  border: 'none',
  borderRadius: radius.sm,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: 600,
  textDecoration: 'underline',
  textUnderlineOffset: 2,
};

const buttonBase: CSSProperties = {
  padding: '4px 12px',
  borderRadius: radius.sm,
  cursor: 'pointer',
  fontSize: fontSize.sm,
  whiteSpace: 'nowrap',
};

const secondaryButtonStyle: CSSProperties = {
  ...buttonBase,
  border: `1px solid ${token('borderStrong')}`,
  background: token('surface'),
  color: token('text'),
};

const accentButtonStyle: CSSProperties = {
  ...buttonBase,
  border: `1px solid ${token('accent')}`,
  background: token('accent'),
  color: token('accentText'),
};
