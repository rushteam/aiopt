import { disabledOpacity, token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { WORKBENCH_LIMITS, type TaskView, type WorkbenchSnapshot } from '../../../shared/workbench';
import { TaskTabBar } from './TaskTabBar';
import { TaskBoardActionsMenu } from './TaskBoardActionsMenu';
import { TASK_TAB_HEIGHT, TASK_TAB_MARGIN_TOP, taskTabToolButtonStyle } from './taskTabChrome';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

export function TaskBoardTabRow({
  tasks,
  selectedId,
  onSelect,
  t,
  wb,
  run,
  onEditTask,
  liveCount,
  onNewTask,
  creating,
  taskFull,
  canRun,
  runnable,
  selectedTask,
  sessionReady,
}: {
  tasks: readonly TaskView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  t: TranslateFn;
  wb: WorkbenchSnapshot;
  run: Runner;
  onEditTask: (id: string) => void;
  liveCount: number;
  onNewTask: () => void;
  creating: boolean;
  taskFull: boolean;
  canRun: boolean;
  runnable: number;
  selectedTask: TaskView | null;
  sessionReady: boolean;
}) {
  const statTitle = `${t('workbench.tasks.taskTotal').replace('{{count}}', String(tasks.length))} · ${t('workbench.tasks.concurrent')} ${liveCount}/${WORKBENCH_LIMITS.liveTasks}`;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        borderBottom: `1px solid ${token('border')}`,
        background: token('bg'),
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: space.sm,
          minHeight: TASK_TAB_HEIGHT + TASK_TAB_MARGIN_TOP,
          paddingLeft: space.sm,
          paddingRight: space.sm,
        }}
      >
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-end' }}>
          {tasks.length > 0 ? (
            <TaskTabBar
              embedded
              tasks={tasks}
              selectedId={selectedId}
              onSelect={onSelect}
              t={t}
              wb={wb}
              run={run}
              onEditTask={onEditTask}
            />
          ) : (
            <span
              style={{
                fontSize: fontSize.sm,
                color: token('textMuted'),
                padding: `${TASK_TAB_MARGIN_TOP}px 4px 6px`,
              }}
            >
              {t('workbench.tasks.empty')}
            </span>
          )}
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'flex-end', flexShrink: 0, gap: 0 }}>
          <button
            type="button"
            aria-label={t('workbench.tasks.new')}
            title={t('workbench.tasks.new')}
            disabled={creating || taskFull}
            onClick={onNewTask}
            {...hoverBackground(token('bg'), token('surfaceHover'))}
            style={{
              ...taskTabToolButtonStyle({
                cursor: creating || taskFull ? 'default' : 'pointer',
                borderRadius: `${radius.sm}px 0 0 0`,
                borderRight: 'none',
                fontSize: fontSize.lg,
                lineHeight: 1,
                opacity: creating || taskFull ? disabledOpacity : 1,
              }),
            }}
          >
            +
          </button>
          <TaskBoardActionsMenu
            paired
            wb={wb}
            t={t}
            run={run}
            selectedTask={selectedTask}
            canRun={canRun}
            runnable={runnable}
            taskCount={tasks.length}
            liveCount={liveCount}
            statTitle={statTitle}
            onEditTask={() => {
              if (selectedTask) onEditTask(selectedTask.id);
            }}
          />
        </div>
      </div>
      {!sessionReady && (
        <p
          style={{
            margin: 0,
            padding: '4px 10px',
            fontSize: fontSize.xs,
            lineHeight: 1.4,
            color: token('textMuted'),
            borderTop: `1px solid ${token('border')}`,
            background: token('surface'),
          }}
        >
          {t('workbench.tasks.sessionRequiredHint')}
        </p>
      )}
    </div>
  );
}
