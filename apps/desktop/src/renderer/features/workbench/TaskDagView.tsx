import { useId, useMemo, type KeyboardEvent } from 'react';
import { layoutTaskDag } from '../../../shared/taskDagLayout';
import type { TaskStatus, TaskView } from '../../../shared/workbench';
import { token, fontSize, radius, space } from '../../themes/tokens';
import type { TranslateFn } from '../../i18n';

const NODE_W = 132;
/** Title starts after the status dot; keep the same inset on the right. */
const LABEL_X = 18;
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
  maxHeight = 120,
}: {
  tasks: readonly TaskView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  t: TranslateFn;
  /** Height cap before the graph scrolls; null lets the parent size it. */
  maxHeight?: number | null;
}) {
  const layout = useMemo(() => layoutTaskDag(tasks), [tasks]);
  // One arrow marker per graph: two views on a page must not share an id.
  const arrowId = `wb-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const approved = useMemo(() => new Set(tasks.filter((x) => x.approved).map((x) => x.id)), [tasks]);
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
      style={{
        padding: `${space.sm}px ${space.md}px`,
        flexShrink: 0,
        ...(maxHeight === null ? { minHeight: 0 } : { maxHeight }),
        overflow: 'auto',
      }}
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
                markerEnd={`url(#${arrowId})`}
              />
            );
          })}
          <defs>
            <marker id={arrowId} markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill={token('borderStrong')} />
            </marker>
          </defs>
          {layout.nodes.map((n) => {
            const p = pos.get(n.id)!;
            const selected = n.id === selectedId;
            const isApproved = approved.has(n.id);
            const onKey = (e: KeyboardEvent<SVGGElement>): void => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(n.id);
              }
            };
            const label = `${n.title} · ${
              isApproved && n.status === 'proposed' ? t('workbench.plan.queued') : t(`workbench.taskStatus.${n.status}`)
            }`;
            return (
              <g
                key={n.id}
                role="button"
                tabIndex={0}
                aria-label={label}
                aria-pressed={selected}
                onClick={() => onSelect(n.id)}
                onKeyDown={onKey}
                style={{ cursor: 'pointer' }}
              >
                <title>{label}</title>
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
                {/* Approved and waiting: a small check in the corner (the label says it too). */}
                {isApproved && n.status === 'proposed' && (
                  <path
                    d={`M${p.x + NODE_W - 13},${p.y + 9} l3,3 l6,-6`}
                    fill="none"
                    stroke={token('accent')}
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  />
                )}
                {/* SVG text cannot ellipsize, and a character count misjudges width (a CJK
                    glyph is about twice a Latin one), so the title is HTML clipped to the node. */}
                <foreignObject
                  x={p.x + LABEL_X}
                  y={p.y}
                  width={NODE_W - LABEL_X * 1.5}
                  height={NODE_H}
                  style={{ pointerEvents: 'none' }}
                >
                  <div
                    style={{
                      height: NODE_H,
                      lineHeight: `${NODE_H}px`,
                      fontSize: fontSize.xs,
                      color: token('text'),
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {n.title}
                  </div>
                </foreignObject>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
