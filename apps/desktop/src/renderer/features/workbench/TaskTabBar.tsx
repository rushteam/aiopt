import { useEffect, useRef } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import type { TaskStatus, TaskView } from '../../../shared/workbench';

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
  flexShrink: 0,
  minHeight: 34,
  padding: `0 ${space.sm}px`,
  borderBottom: `1px solid ${token('border')}`,
  background: token('bg'),
  scrollbarGutter: 'stable' as const,
};

export function TaskTabBar({
  tasks,
  selectedId,
  onSelect,
  t,
}: {
  tasks: readonly TaskView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  t: TranslateFn;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedId]);

  if (tasks.length === 0) return null;

  return (
    <div ref={scrollRef} role="tablist" aria-label={t('workbench.tasks.list')} style={tabBarStyle}>
      {tasks.map((task) => {
        const selected = task.id === selectedId;
        return (
          <button
            key={task.id}
            ref={selected ? selectedRef : undefined}
            type="button"
            role="tab"
            aria-selected={selected}
            title={task.title}
            onClick={() => onSelect(task.id)}
            {...hoverBackground(selected ? token('surface') : token('bg'), token('surfaceHover'))}
            style={{
              all: 'unset',
              boxSizing: 'border-box',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              flexShrink: 0,
              maxWidth: 220,
              minWidth: 72,
              height: 30,
              marginTop: 4,
              padding: '0 12px',
              borderRadius: `${radius.sm}px ${radius.sm}px 0 0`,
              border: `1px solid ${selected ? token('border') : token('borderStrong')}`,
              borderBottom: selected ? `1px solid ${token('surface')}` : `1px solid ${token('border')}`,
              marginBottom: selected ? -1 : 0,
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
      })}
    </div>
  );
}
