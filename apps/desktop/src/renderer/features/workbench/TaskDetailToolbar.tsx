import { useState, type CSSProperties } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import {
  isLiveTaskStatus,
  pendingDependencies,
  taskAllows,
  taskDependenciesMet,
  type FolderView,
  type TaskView,
  type WorkbenchSnapshot,
} from '../../../shared/workbench';
import { completeTask, launchTask, removeTask, stopTask, updateTask } from '../../lib/workbenchStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { StatusLabel } from './TaskStatusLabel';
type Runner = (action: () => Promise<void>) => Promise<boolean>;

export function TaskDetailToolbar({
  task,
  wb,
  t,
  run,
  canLaunch,
  onEdit,
}: {
  task: TaskView;
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
  canLaunch: boolean;
  onEdit: () => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const folder = wb.folders.find((f) => f.id === task.folderId) ?? null;
  const placeLocked = task.worktreeDisplay !== null;
  const editable = taskAllows('edit', task.status);
  const waitingOn = pendingDependencies(task, wb.tasks);
  const launchable = taskAllows('launch', task.status) && canLaunch && folder !== null && taskDependenciesMet(task, wb.tasks);
  const live = isLiveTaskStatus(task.status);

  return (
    <div
      style={{
        flexShrink: 0,
        padding: '4px 10px',
        borderBottom: `1px solid ${token('border')}`,
        display: 'flex',
        flexWrap: 'nowrap',
        alignItems: 'center',
        gap: space.sm,
        fontSize: fontSize.sm,
        color: token('textMuted'),
        overflowX: 'auto',
        minHeight: 36,
        background: token('surface'),
      }}
    >
      <StatusLabel status={task.status} t={t} />
      {taskAllows('launch', task.status) && (
        <button
          type="button"
          onClick={() => void run(() => launchTask(task.id))}
          disabled={!launchable}
          {...hoverBackground(token('accent'), token('accentHover'))}
          style={{
            all: 'unset',
            cursor: launchable ? 'pointer' : 'default',
            fontSize: fontSize.sm,
            fontWeight: 600,
            padding: '3px 8px',
            borderRadius: radius.sm,
            background: token('accent'),
            color: token('accentText'),
            opacity: launchable ? 1 : 0.5,
            flexShrink: 0,
          }}
        >
          {task.status === 'proposed' ? t('workbench.actions.launch') : t('workbench.actions.relaunch')}
        </button>
      )}
      {taskAllows('complete', task.status) && (
        <button type="button" onClick={() => void run(() => completeTask(task.id))} {...hoverBackground('transparent', token('surfaceHover'))} style={ghostBtn}>
          {t('workbench.actions.complete')}
        </button>
      )}
      {taskAllows('stop', task.status) && (
        <button
          type="button"
          onClick={() => void run(() => stopTask(task.id))}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={{ ...ghostBtn, color: token('danger') }}
        >
          {t('workbench.actions.stop')}
        </button>
      )}
      {task.failure && (
        <span style={{ color: token('danger'), flexShrink: 0 }}>{t(`workbench.failure.${task.failure}`)}</span>
      )}
      {waitingOn.length > 0 && (
        <span style={{ flexShrink: 0 }}>
          {t('workbench.tasks.waitingOn')} {waitingOn.map((d) => d.title).join(', ')}
        </span>
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
        <span style={{ flexShrink: 0 }}>
          {t('workbench.tasks.worktree')}{' '}
          <code style={{ fontSize: fontSize.xs }}>{task.worktreeDisplay}</code>
        </span>
      )}
      {live && task.agentName && (
        <span style={{ fontSize: fontSize.xs, flexShrink: 0, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t('workbench.tasks.attach')} herdr attach {task.agentName}
        </span>
      )}
      <span style={{ flex: 1, minWidth: 8 }} />
      {editable && (
        <button type="button" onClick={onEdit} {...hoverBackground('transparent', token('surfaceHover'))} style={{ ...ghostBtn, flexShrink: 0 }}>
          {t('workbench.actions.editTask')}
        </button>
      )}
      {taskAllows('remove', task.status) && (
        <button
          type="button"
          onClick={() => (task.worktreeDisplay ? setConfirmRemove(true) : void run(() => removeTask(task.id)))}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={{ ...ghostBtn, color: token('danger'), flexShrink: 0 }}
        >
          {t('workbench.actions.remove')}
        </button>
      )}
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

const ghostBtn: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  fontSize: fontSize.sm,
  padding: '3px 8px',
  borderRadius: radius.sm,
  color: token('text'),
  flexShrink: 0,
};

function PlacePicker({
  t,
  folders,
  folderId,
  isolated,
  onChange,
}: {
  t: TranslateFn;
  folders: readonly FolderView[];
  folderId: string | null;
  isolated: boolean;
  onChange: (folderId: string | null, isolated: boolean) => void;
}) {
  const folder = folders.find((f) => f.id === folderId) ?? null;
  const canIsolate = folder?.isGitRepo === true;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: space.sm, flexShrink: 0 }}>
      <select
        value={folder?.id ?? ''}
        onChange={(e) => {
          const next = folders.find((f) => f.id === e.target.value) ?? null;
          onChange(next?.id ?? null, next?.isGitRepo ? isolated : false);
        }}
        style={{
          maxWidth: 120,
          padding: '2px 6px',
          borderRadius: radius.sm,
          border: `1px solid ${token('borderStrong')}`,
          background: token('bg'),
          color: token('text'),
          fontSize: fontSize.sm,
        }}
      >
        <option value="">{t('workbench.tasks.noFolder')}</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <label
        title={canIsolate ? undefined : t('workbench.tasks.isolatedUnavailable')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          whiteSpace: 'nowrap',
          fontSize: fontSize.xs,
          color: canIsolate ? token('text') : token('textMuted'),
        }}
      >
        <input
          type="checkbox"
          checked={isolated && canIsolate}
          disabled={!canIsolate}
          onChange={(e) => onChange(folderId, e.target.checked)}
        />
        {t('workbench.tasks.isolated')}
      </label>
    </div>
  );
}
