import { token, fontSize, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { WORKBENCH_LIMITS, type TaskView, type WorkbenchSnapshot } from '../../../shared/workbench';
import { TaskTabBar } from './TaskTabBar';
import { TaskBoardActionsMenu } from './TaskBoardActionsMenu';
import { TASK_TAB_RAIL_WIDTH, taskRailStatBlockStyle, taskRailToolButtonStyle } from './taskTabChrome';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

/** Vertical task rail: summary, tab list, new-task and board actions. */
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
}) {
  const statTitle = `${t('workbench.tasks.taskTotal').replace('{{count}}', String(tasks.length))} · ${t('workbench.tasks.concurrent')} ${liveCount}/${WORKBENCH_LIMITS.liveTasks}`;

  return (
    <aside
      aria-label={t('workbench.tasks.title')}
      style={{
        width: TASK_TAB_RAIL_WIDTH,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderRight: `1px solid ${token('border')}`,
        background: token('bg'),
      }}
    >
      <div title={statTitle} aria-label={statTitle} style={taskRailStatBlockStyle()}>
        <span style={{ color: token('text'), fontWeight: 600, fontSize: fontSize.sm }}>{tasks.length}</span>
        <span style={{ fontSize: fontSize.xs }}>
          {t('workbench.tasks.concurrent')} {liveCount}/{WORKBENCH_LIMITS.liveTasks}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tasks.length > 0 ? (
          <TaskTabBar
            embedded
            vertical
            tasks={tasks}
            selectedId={selectedId}
            onSelect={onSelect}
            t={t}
            wb={wb}
            run={run}
            onEditTask={onEditTask}
          />
        ) : (
          <p
            style={{
              margin: 0,
              padding: space.md,
              fontSize: fontSize.xs,
              lineHeight: 1.45,
              color: token('textMuted'),
            }}
          >
            {t('workbench.tasks.empty')}
          </p>
        )}
      </div>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: space.xs,
          padding: space.sm,
          borderTop: `1px solid ${token('border')}`,
        }}
      >
        <button
          type="button"
          aria-label={t('workbench.tasks.new')}
          title={t('workbench.tasks.new')}
          disabled={creating || taskFull}
          onClick={onNewTask}
          {...hoverBackground(token('bg'), token('surfaceHover'))}
          style={{
            ...taskRailToolButtonStyle({
              cursor: creating || taskFull ? 'default' : 'pointer',
              fontSize: fontSize.lg,
              lineHeight: 1,
              opacity: creating || taskFull ? 0.45 : 1,
            }),
          }}
        >
          +
        </button>
        <TaskBoardActionsMenu
          rail
          wb={wb}
          t={t}
          run={run}
          selectedTask={selectedTask}
          canRun={canRun}
          runnable={runnable}
          onEditTask={() => {
            if (selectedTask) onEditTask(selectedTask.id);
          }}
        />
      </div>
    </aside>
  );
}
