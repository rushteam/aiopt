// The approval card the coordinator's chat shows for one `propose_tasks` call (human in the
// loop). Each task the coordinator proposed waits here until the user picks its folder and
// approves it; "Run plan" approves the conversation's whole plan at once. An approved task
// starts as soon as its dependencies are done and a worker slot is free. The card holds only
// task ids and reads each task's live state from the board, so it stays in step with the plan.
//
// Approving goes through IPC (approveTasks / runPlan / updateTask). Main re-checks every
// precondition (status, folder, dependencies, live limit); the disabled states here only
// mirror it.

import type { CSSProperties } from 'react';
import { disabledOpacity, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { approveTasks, runPlan, updateTask } from '../../lib/workbenchStore';
import { Select } from '../../components/ui/Select';
import { pendingDependencies, taskAllows, type TaskView, type WorkbenchSnapshot } from '../../../shared/workbench';
import { StatusLabel } from './TaskStatusLabel';
import { proposalBlocker } from './proposalBlocker';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

export function ProposalCard({
  taskIds,
  wb,
  t,
  run,
  onSelectTask,
}: {
  taskIds: readonly string[];
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
  onSelectTask: (id: string) => void;
}) {
  // Tasks removed from the board since drop out of the card.
  const tasks = taskIds
    .map((id) => wb.tasks.find((task) => task.id === id))
    .filter((task): task is TaskView => task !== undefined);
  if (tasks.length === 0) return null;

  const unapproved = tasks.filter((task) => task.status === 'proposed' && !task.approved);
  const conversationId = tasks[0]!.conversationId;
  // Approving needs a running workbench; a folder or dependency can still be pending (the
  // task then waits, approved, and starts once it is ready).
  const canApprove = wb.status === 'ready' && wb.herdrAvailable;
  const canRunPlan = canApprove && conversationId !== null && unapproved.length > 0;

  return (
    <div role="group" aria-label={t('workbench.proposal.title')} style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.md }}>
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: token('textMuted') }}>
          {t('workbench.proposal.title')}
        </span>
        <span style={{ flex: 1 }} />
        {unapproved.length > 0 && conversationId !== null && (
          <button
            type="button"
            disabled={!canRunPlan}
            title={t('workbench.plan.runHint')}
            onClick={() => void run(() => runPlan(conversationId))}
            {...(canRunPlan ? hoverBackground(token('accent'), token('accentHover')) : {})}
            style={{ ...accentButtonStyle, opacity: canRunPlan ? 1 : disabledOpacity }}
          >
            {t('workbench.plan.run')}
          </button>
        )}
      </div>
      <p style={{ margin: 0, fontSize: fontSize.xs, color: token('textMuted') }}>{t('workbench.proposal.hint')}</p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: space.sm }}>
        {tasks.map((task) => (
          <ProposalRow key={task.id} task={task} wb={wb} t={t} run={run} onSelectTask={onSelectTask} />
        ))}
      </ul>
    </div>
  );
}

function ProposalRow({
  task,
  wb,
  t,
  run,
  onSelectTask,
}: {
  task: TaskView;
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
  onSelectTask: (id: string) => void;
}) {
  const proposed = task.status === 'proposed';
  const blocker = proposed ? proposalBlocker(task, wb) : null;
  const canEditFolder = proposed && taskAllows('edit', task.status);
  const waitingOn = blocker === 'dependencies' ? pendingDependencies(task, wb.tasks) : [];
  // Approve is possible whenever the workbench runs; the approved task waits for the rest.
  const canApprove = proposed && !task.approved && blocker !== 'session';

  return (
    <li style={rowStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.md, minWidth: 0 }}>
        <button
          type="button"
          onClick={() => onSelectTask(task.id)}
          title={task.prompt}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={titleButtonStyle}
        >
          {task.title}
        </button>
        <StatusLabel status={task.status} approved={task.approved} t={t} />
      </div>
      {proposed && (
        <div style={{ display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'wrap' }}>
          <Select
            value={task.folderId ?? ''}
            disabled={!canEditFolder}
            size="sm"
            aria-label={t('workbench.tasks.folderLabel')}
            style={{ maxWidth: 200 }}
            onChange={(value) => {
              const folder = wb.folders.find((f) => f.id === value) ?? null;
              void run(() =>
                updateTask({
                  taskId: task.id,
                  folderId: folder?.id ?? null,
                  isolated: folder?.isGitRepo ? task.isolated : false,
                }),
              );
            }}
            options={[
              { value: '', label: t('workbench.tasks.noFolder') },
              ...wb.folders.map((f) => ({ value: f.id, label: f.name })),
            ]}
          />
          <span style={{ flex: 1 }} />
          {blocker !== null && (
            <span style={{ fontSize: fontSize.xs, color: token('textMuted'), minWidth: 0, overflowWrap: 'anywhere' }}>
              {blocker === 'dependencies'
                ? `${t('workbench.tasks.waitingOn')} ${waitingOn.map((d) => d.title).join(', ')}`
                : t(`workbench.proposal.blocked.${blocker}`)}
            </span>
          )}
          {task.approved ? (
            <span style={{ fontSize: fontSize.xs, color: token('accent'), whiteSpace: 'nowrap' }}>
              {t('workbench.plan.approved')}
            </span>
          ) : (
            <button
              type="button"
              disabled={!canApprove}
              onClick={() => void run(() => approveTasks([task.id]))}
              {...(canApprove ? hoverBackground(token('accent'), token('accentHover')) : {})}
              style={{ ...accentButtonStyle, opacity: canApprove ? 1 : disabledOpacity }}
            >
              {t('workbench.plan.approve')}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

const cardStyle: CSSProperties = {
  border: `1px solid ${token('border')}`,
  borderRadius: radius.md,
  background: token('surface'),
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: space.sm,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.sm,
  padding: '8px 10px',
  borderRadius: radius.sm,
  border: `1px solid ${token('border')}`,
  background: token('bg'),
};

const titleButtonStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  textAlign: 'left',
  padding: '2px 4px',
  margin: '-2px -4px',
  border: 'none',
  borderRadius: radius.sm,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.base,
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const accentButtonStyle: CSSProperties = {
  padding: '4px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('accent')}`,
  background: token('accent'),
  color: token('accentText'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
  whiteSpace: 'nowrap',
};
