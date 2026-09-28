import { useMemo } from 'react';
import { layoutTaskDag } from '../../../shared/taskDagLayout';
import type { TaskStatus, TaskView } from '../../../shared/workbench';
import { token, fontSize, radius, space } from '../../themes/tokens';
import type { TranslateFn } from '../../i18n';

const NODE_W = 112;
const NODE_H = 36;
const GAP_X = 20;
const GAP_Y = 48;
const PAD = 12;

function statusColor(status: TaskStatus): string {
  if (status === 'working' || status === 'starting') return token('accent');
  if (status === 'blocked' || status === 'failed') return token('danger');
  if (status === 'review' || status === 'done') return token('success');
  return token('borderStrong');
}

export function TaskDagView({
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
  const layout = useMemo(() => layoutTaskDag(tasks), [tasks]);
  if (layout.nodes.length === 0) return null;

  const width = Math.max(1, layout.maxWidth) * (NODE_W + GAP_X) - GAP_X + PAD * 2;
  const height = Math.max(1, layout.layerCount) * (NODE_H + GAP_Y) - GAP_Y + PAD * 2;

  const pos = new Map<string, { x: number; y: number; cx: number; cy: number }>();
  for (const n of layout.nodes) {
    const rowW = layout.nodes.filter((x) => x.layer === n.layer).length;
    const x = PAD + n.indexInLayer * (NODE_W + GAP_X) + (layout.maxWidth - rowW) * ((NODE_W + GAP_X) / 2);
    const y = PAD + n.layer * (NODE_H + GAP_Y);
    pos.set(n.id, { x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2 });
  }

  return (
    <section
      aria-label={t('workbench.plan.title')}
      style={{ padding: `${space.sm}px ${space.md}px`, flexShrink: 0, maxHeight: 120, overflow: 'auto' }}
    >
      <div style={{ overflowX: 'auto' }}>
        <svg width={width} height={height} role="img" aria-label={t('workbench.plan.title')}>
          {layout.edges.map((e) => {
            const a = pos.get(e.fromId);
            const b = pos.get(e.toId);
            if (!a || !b) return null;
            return (
              <line
                key={`${e.fromId}-${e.toId}`}
                x1={a.cx}
                y1={a.y + NODE_H}
                x2={b.cx}
                y2={b.y}
                stroke={token('borderStrong')}
                strokeWidth={1.5}
                markerEnd="url(#wb-arrow)"
              />
            );
          })}
          <defs>
            <marker id="wb-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill={token('borderStrong')} />
            </marker>
          </defs>
          {layout.nodes.map((n) => {
            const p = pos.get(n.id)!;
            const selected = n.id === selectedId;
            return (
              <g key={n.id} onClick={() => onSelect(n.id)} style={{ cursor: 'pointer' }}>
                <rect
                  x={p.x}
                  y={p.y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={radius.sm}
                  fill={token('surface')}
                  stroke={selected ? token('accent') : token('borderStrong')}
                  strokeWidth={selected ? 2 : 1}
                />
                <circle cx={p.x + 8} cy={p.y + NODE_H / 2} r={4} fill={statusColor(n.status)} />
                <text
                  x={p.x + 16}
                  y={p.y + NODE_H / 2 + 4}
                  fontSize={11}
                  fill={token('text')}
                  style={{ pointerEvents: 'none' }}
                >
                  {n.title.length > 12 ? `${n.title.slice(0, 11)}…` : n.title}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
