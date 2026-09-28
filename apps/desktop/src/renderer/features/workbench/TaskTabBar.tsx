import { useEffect, useRef } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import type { TaskStatus, TaskView, WorkbenchSnapshot } from '../../../shared/workbench';
import { TASK_MENTION_DRAG_TYPE } from '../../../shared/taskMention';
import { TaskTabActionsMenu } from './TaskTabActionsMenu';
import { TASK_TAB_HEIGHT, TASK_TAB_MARGIN_BOTTOM, TASK_TAB_MARGIN_TOP } from './taskTabChrome';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

function statusDot(status: TaskStatus): string {
  if (status === 'working' || status === 'starting') return token('accent');
  if (status === 'blocked' || status === 'failed') return token('danger');
  if (status === 'review' || status === 'done') return token('success');
  return token('borderStrong');
}

const tabBarStyle = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 0,
  overflowX: 'auto' as const,
  overflowY: 'hidden' as const,
  flex: 1,
  minWidth: 0,
  minHeight: TASK_TAB_HEIGHT + TASK_TAB_MARGIN_TOP,
  scrollbarGutter: 'stable' as const,
};

export function TaskTabBar({
  tasks,
  selectedId,
  onSelect,
  t,
  wb,
  run,
  onEditTask,
  embedded = false,
}: {
  tasks: readonly TaskView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  t: TranslateFn;
  wb: WorkbenchSnapshot;
  run: Runner;
  onEditTask: (taskId: string) => void;
  /** When true, omit outer chrome (used inside {@link TaskBoardTabRow}). */
  embedded?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedId]);

  if (tasks.length === 0) return null;

  return (
    <div
      ref={scrollRef}
      role="tablist"
      aria-label={t('workbench.tasks.list')}
      style={embedded ? tabBarStyle : { ...tabBarStyle, flexShrink: 0, padding: `0 ${space.sm}px`, borderBottom: `1px solid ${token('border')}`, background: token('bg') }}
    >
      {tasks.map((task) => {
        const selected = task.id === selectedId;
        const tabButton = (
          <button
            ref={selected ? selectedRef : undefined}
            type="button"
            role="tab"
            aria-selected={selected}
            title={`${task.title}\n${t('workbench.tasks.dragMention')}`}
            onClick={() => onSelect(task.id)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(TASK_MENTION_DRAG_TYPE, JSON.stringify({ id: task.id, title: task.title }));
              e.dataTransfer.effectAllowed = 'copy';
            }}
            {...hoverBackground(selected ? token('surface') : token('bg'), token('surfaceHover'))}
            style={{
              all: 'unset',
              boxSizing: 'border-box',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              flex: 1,
              minWidth: 0,
              maxWidth: '100%',
              height: TASK_TAB_HEIGHT,
              marginTop: TASK_TAB_MARGIN_TOP,
              padding: '0 12px',
              borderRadius: selected ? `${radius.sm}px 0 0 0` : `${radius.sm}px ${radius.sm}px 0 0`,
              border: `1px solid ${selected ? token('border') : token('borderStrong')}`,
              borderRight: selected ? 'none' : undefined,
              borderBottom: selected ? `1px solid ${token('surface')}` : `1px solid ${token('border')}`,
              marginBottom: selected ? TASK_TAB_MARGIN_BOTTOM : 0,
              background: selected ? token('surface') : token('bg'),
              fontSize: fontSize.sm,
              color: selected ? token('text') : token('textMuted'),
              position: 'relative',
              zIndex: selected ? 1 : 0,
            }}
          >
            <span
              aria-hidden
              style={{ width: 6, height: 6, borderRadius: '50%', background: statusDot(task.status), flexShrink: 0 }}
            />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
          </button>
        );

        return (
          <div
            key={task.id}
            style={{
              display: 'inline-flex',
              alignItems: 'flex-end',
              flex: selected ? '1 1 160px' : '0 0 auto',
              minWidth: selected ? 100 : 52,
              maxWidth: selected ? 480 : 136,
            }}
          >
            {tabButton}
            {selected && (
              <TaskTabActionsMenu task={task} wb={wb} t={t} run={run} onEdit={() => onEditTask(task.id)} />
            )}
          </div>
        );
      })}
    </div>
  );
}
