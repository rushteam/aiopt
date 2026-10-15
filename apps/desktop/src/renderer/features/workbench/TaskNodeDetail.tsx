// One node of a plan, opened from the DAG: where it stands, what it waits on, the actions it
// takes now (approve, run again, stop, mark done, edit, remove), and its worker conversation.
//
// Every action is the same IPC call the task board makes; main re-checks each one. The
// disabled states here only mirror main's rules (TASK_ACTIONS, proposalBlocker).

import { useState, type CSSProperties, type ReactNode } from 'react';
import { disabledOpacity, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import {
  approveTasks,
  completeTask,
  launchTask,
  removeTask,
  stopTask,
  updateTask,
} from '../../lib/workbenchStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { pendingDependencies, taskAllows, type TaskView, type WorkbenchSnapshot } from '../../../shared/workbench';
import { StatusLabel } from './TaskStatusLabel';
import { TaskChatPane } from './TaskChatPane';
import { TaskForm } from './TaskForm';
import { proposalBlocker } from './proposalBlocker';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

export function TaskNodeDetail({
  task,
  planTasks,
  wb,
  t,
  run,
}: {
  task: TaskView;
  /** The other tasks of this node's plan (dependency choices and labels). */
  planTasks: readonly TaskView[];
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const folder = wb.folders.find((f) => f.id === task.folderId) ?? null;
  const waitingOn = pendingDependencies(task, wb.tasks);
  const dependencyTitles = task.dependsOn
    .map((id) => wb.tasks.find((x) => x.id === id)?.title)
    .filter((title): title is string => title !== undefined);
  const blocker = taskAllows('launch', task.status) ? proposalBlocker(task, wb) : null;
  const canLaunchNow = taskAllows('launch', task.status) && blocker === null;

  if (editing) {
    return (
      <div style={{ padding: space.md, overflowY: 'auto', minHeight: 0 }}>
        <TaskForm
          t={t}
          folders={wb.folders}
          submitLabel={t('workbench.tasks.save')}
          lockPlace={task.worktreeDisplay !== null}
          dependencyChoices={planTasks.filter((x) => x.id !== task.id).map((x) => ({ id: x.id, title: x.title }))}
          initial={{
            title: task.title,
            prompt: task.prompt,
            folderId: task.folderId,
            isolated: task.isolated,
            dependsOn: task.dependsOn,
          }}
          onCancel={() => setEditing(false)}
          onSubmit={async (draft) => {
            const placeLocked = task.worktreeDisplay !== null;
            const ok = await run(() =>
              updateTask({
                taskId: task.id,
                title: draft.title,
                prompt: draft.prompt,
                dependsOn: draft.dependsOn ?? task.dependsOn,
                ...(placeLocked ? {} : { folderId: draft.folderId, isolated: draft.isolated }),
              }),
            );
            if (ok) setEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: space.md, minWidth: 0 }}>
          <h3 style={titleStyle} title={task.title}>
            {task.title}
          </h3>
          <StatusLabel status={task.status} approved={task.approved} t={t} />
        </div>
        <dl style={metaStyle}>
          <Meta label={t('workbench.tasks.folderLabel')}>{folder?.name ?? t('workbench.tasks.noFolder')}</Meta>
          {dependencyTitles.length > 0 && <Meta label={t('workbench.plan.dependsOn')}>{dependencyTitles.join(', ')}</Meta>}
          {task.branch && <Meta label={t('workbench.tasks.branch')}>{task.branch}</Meta>}
        </dl>
        {task.failure && (
          <p style={{ margin: 0, fontSize: fontSize.sm, color: token('danger') }}>{t(`workbench.failure.${task.failure}`)}</p>
        )}
        {waitingOn.length > 0 && (
          <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted') }}>
            {t('workbench.tasks.waitingOn')} {waitingOn.map((d) => d.title).join(', ')}
          </p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
          {task.status === 'proposed' && !task.approved && (
            <ActionButton accent disabled={blocker === 'session'} onClick={() => void run(() => approveTasks([task.id]))}>
              {t('workbench.plan.approve')}
            </ActionButton>
          )}
          {(task.status === 'stopped' || task.status === 'failed' || task.status === 'done') && (
            <ActionButton accent disabled={!canLaunchNow} onClick={() => void run(() => launchTask(task.id))}>
              {t('workbench.actions.relaunch')}
            </ActionButton>
          )}
          {taskAllows('complete', task.status) && (
            <ActionButton onClick={() => void run(() => completeTask(task.id))}>{t('workbench.actions.complete')}</ActionButton>
          )}
          {taskAllows('stop', task.status) && (
            <ActionButton danger onClick={() => void run(() => stopTask(task.id))}>
              {t('workbench.actions.stop')}
            </ActionButton>
          )}
          {taskAllows('edit', task.status) && (
            <ActionButton onClick={() => setEditing(true)}>{t('workbench.actions.edit')}</ActionButton>
          )}
          {taskAllows('remove', task.status) && (
            <ActionButton
              danger
              onClick={() => {
                // A worktree holds the task's checkout: confirm before removing it.
                if (task.worktreeDisplay) setConfirmRemove(true);
                else void run(() => removeTask(task.id));
              }}
            >
              {t('workbench.actions.remove')}
            </ActionButton>
          )}
          {blocker !== null && blocker !== 'dependencies' && taskAllows('launch', task.status) && (
            <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>{t(`workbench.proposal.blocked.${blocker}`)}</span>
          )}
        </div>
        {task.status === 'done' && (
          <p style={{ margin: 0, fontSize: fontSize.xs, color: token('textMuted') }}>{t('workbench.plan.rerunHint')}</p>
        )}
      </div>
      <TaskChatPane task={task} wb={wb} t={t} run={run} />
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
    </div>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: space.xs, minWidth: 0 }}>
      <dt style={{ color: token('textMuted'), flexShrink: 0 }}>{label}</dt>
      <dd style={{ margin: 0, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {children}
      </dd>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled = false,
  accent = false,
  danger = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
  danger?: boolean;
}) {
  const base = accent ? token('accent') : 'transparent';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      {...(disabled ? {} : hoverBackground(base, accent ? token('accentHover') : token('surfaceHover')))}
      style={{
        padding: '4px 12px',
        borderRadius: radius.sm,
        border: `1px solid ${accent ? token('accent') : token('borderStrong')}`,
        background: base,
        color: accent ? token('accentText') : danger ? token('danger') : token('text'),
        cursor: disabled ? 'default' : 'pointer',
        fontSize: fontSize.sm,
        whiteSpace: 'nowrap',
        opacity: disabled ? disabledOpacity : 1,
      }}
    >
      {children}
    </button>
  );
}

const headerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.sm,
  padding: space.md,
  borderBottom: `1px solid ${token('border')}`,
  flexShrink: 0,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: fontSize.md,
  fontWeight: 600,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const metaStyle: CSSProperties = {
  margin: 0,
  display: 'flex',
  flexWrap: 'wrap',
  gap: `${space.xs}px ${space.lg}px`,
  fontSize: fontSize.sm,
};
