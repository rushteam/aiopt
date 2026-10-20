// "Routing flow": a live diagram above the routing-group cards — Agents on the left, each
// routing group in the middle, its members on the right. Every new routing decision in the
// status snapshot becomes a pulse that travels Agent → routing group → member; a failover
// shows the failed hop turning red before a second pulse heads for the next member.
//
// Read-only: it draws the content-free status snapshot (ids / status codes / times) and
// adds no collection of its own. Clicking a node opens the Recent routing drawer.
//
// Cost and motion rules:
//   • Pulses move with the Web Animations API on `transform` / `opacity` only — no injected
//     stylesheet (CSP) and no repaint of the static diagram.
//   • Nothing runs while idle: no timers unless a member is cooling (its countdown ring).
//   • No pulses while the window is hidden or the panel is collapsed, and missed decisions
//     are never replayed (the drawer has the history).
//   • `prefers-reduced-motion`: no pulses; the newest path is highlighted for a moment.
//   • Pulse timing is illustrative (motion.flowHop per hop); real latency is in the drawer.

import { useEffect, useMemo, useRef, useState } from 'react';
import { fontSize, motion, radius, space, token, type TokenName } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import type { AgentSummary, ProviderSummary } from '../../../shared/ipc-channels';
import type { AgentId } from '../../../shared/aiProviders';
import { AGENT_SPECS } from '../../../shared/aiProviders';
import { ROUTING_COOLDOWN_MS, type RoutingGroupSummary } from '../../../shared/routingGroups';
import type { RoutingGroupStatus, RoutingStatusSnapshot } from '../../../shared/routingStatus';
import { MEMBER_SERIES_COLORS, memberLabel, useTickingNow } from './RoutingStatusViews';
import {
  agentReach,
  coalescePulses,
  edgePath,
  edgePoints,
  fitLabel,
  flowAgentIds,
  layoutFlow,
  resolveFlowCollapsed,
  ROUTING_FLOW_COLLAPSED_KEY,
  shares,
  takeNewDecisions,
  type FlowLayout,
  type FlowPulse,
} from './routingFlow';

/** Member edge colors, in member order — the same series as the hit-share bar on the card. */
const FLOW_MEMBER_COLORS = MEMBER_SERIES_COLORS;

const SVG_NS = 'http://www.w3.org/2000/svg';

const agentName = (id: string): string =>
  Object.hasOwn(AGENT_SPECS, id) ? AGENT_SPECS[id as keyof typeof AGENT_SPECS].name : id;

function readCollapsed(): string | null {
  try {
    return localStorage.getItem(ROUTING_FLOW_COLLAPSED_KEY);
  } catch {
    return null;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(ROUTING_FLOW_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Preference only; ignore quota or private mode.
  }
}

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    const on = () => setReduced(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, []);
  return reduced;
}

function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

interface PulseBatch {
  seq: number;
  pulses: FlowPulse[];
}

export function RoutingFlowPanel({
  t,
  groups,
  agents,
  providers,
  status,
  onOpenRecent,
}: {
  t: TranslateFn;
  groups: RoutingGroupSummary[];
  agents: AgentSummary[];
  providers: ProviderSummary[];
  status: RoutingStatusSnapshot;
  onOpenRecent: (groupId: string) => void;
}) {
  const hasTraffic = status.recent.length > 0 || status.groups.some((g) => g.lastHour.requests > 0);
  const [stored, setStored] = useState(readCollapsed);
  const collapsed = resolveFlowCollapsed(stored, hasTraffic);
  const reduced = usePrefersReducedMotion();

  // Turn new decisions into one batch of pulses. The first snapshot only sets the mark.
  const lastSeen = useRef<number | null>(null);
  const [batch, setBatch] = useState<PulseBatch>({ seq: 0, pulses: [] });
  useEffect(() => {
    if (status.at === 0) return; // the store's placeholder before the first real snapshot
    const { fresh, lastSeenId } = takeNewDecisions(status.recent, lastSeen.current);
    const primed = lastSeen.current !== null;
    lastSeen.current = lastSeenId;
    if (!primed || fresh.length === 0 || collapsed || document.hidden) return;
    const pulses = coalescePulses(fresh, groups);
    if (pulses.length > 0) setBatch((b) => ({ seq: b.seq + 1, pulses }));
  }, [status, groups, collapsed]);

  const totals = status.groups.reduce(
    (acc, g) => ({ requests: acc.requests + g.lastHour.requests, failovers: acc.failovers + g.lastHour.failovers }),
    { requests: 0, failovers: 0 },
  );

  return (
    <section aria-label={t('providers.routingFlow.title')} style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.md }}>
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => {
            writeCollapsed(!collapsed);
            setStored(collapsed ? '0' : '1');
          }}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={toggleStyle}
        >
          <span aria-hidden style={{ display: 'inline-block', width: 10 }}>
            {collapsed ? '▸' : '▾'}
          </span>
          {t('providers.routingFlow.title')}
        </button>
        <span style={{ marginLeft: 'auto', fontSize: fontSize.xs, color: token('textMuted') }}>
          {totals.requests > 0
            ? t('providers.routingStatus.summary')
                .replace('{{count}}', String(totals.requests))
                .replace('{{failovers}}', String(totals.failovers))
            : t('providers.routingFlow.idle')}
        </span>
      </div>
      {!collapsed && (
        <div style={{ display: 'grid', gap: space.sm, marginTop: space.sm }}>
          {groups.map((group, i) => (
            <div
              key={group.id}
              style={i > 0 ? { borderTop: `1px solid ${token('border')}`, paddingTop: space.sm } : undefined}
            >
              <FlowRow
                t={t}
                group={group}
                agents={agents}
                providers={providers}
                status={status.groups.find((g) => g.groupId === group.id)}
                recent={status.recent}
                batch={batch}
                reduced={reduced}
                onOpenRecent={() => onOpenRecent(group.id)}
              />
            </div>
          ))}
          {!hasTraffic && (
            <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted') }}>
              {t('providers.routingFlow.empty')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

type Focus = { kind: 'agent'; slot: number } | { kind: 'member'; slot: number } | null;

interface Highlight {
  agentSlot: number;
  memberSlots: number[];
  ok: boolean;
}

function FlowRow({
  t,
  group,
  agents,
  providers,
  status,
  recent,
  batch,
  reduced,
  onOpenRecent,
}: {
  t: TranslateFn;
  group: RoutingGroupSummary;
  agents: AgentSummary[];
  providers: ProviderSummary[];
  status: RoutingGroupStatus | undefined;
  recent: RoutingStatusSnapshot['recent'];
  batch: PulseBatch;
  reduced: boolean;
  onOpenRecent: () => void;
}) {
  const [boxRef, width] = useElementWidth<HTMLDivElement>();
  const agentIds = useMemo(() => flowAgentIds(group, agents, recent), [group, agents, recent]);
  const layout = useMemo(
    () =>
      layoutFlow(
        width,
        agentIds.map((id) => ({ key: id, label: agentName(id) })),
        group.members.map((m) => ({
          key: `${m.providerId}\u241f${m.modelId}`,
          label: memberLabel(providers, m.providerId, m.modelId),
        })),
        (n) => t('providers.routingFlow.more').replace('{{count}}', String(n)),
      ),
    [width, agentIds, group.members, providers, t],
  );

  // Edge weights: Agents by their share of this group's recent decisions; members by the
  // last-hour answer share. Folded entries add into their "+N" node.
  const agentWeights = useMemo(() => {
    const counts = new Array<number>(layout.agents.length).fill(0);
    for (const d of recent) {
      if (d.groupId !== group.id) continue;
      const i = agentIds.indexOf(d.agentId);
      if (i >= 0) counts[layout.agentSlot[i]!]! += 1;
    }
    return shares(counts);
  }, [recent, group.id, agentIds, layout]);
  const memberWeights = useMemo(() => {
    const counts = new Array<number>(layout.members.length).fill(0);
    (status?.lastHour.hits ?? []).forEach((h, i) => {
      const slot = layout.memberSlot[i];
      if (slot !== undefined) counts[slot]! += h;
    });
    return shares(counts);
  }, [status, layout]);

  const reach = useMemo(() => agentReach(group.id, group, recent), [group, recent]);
  const [focus, setFocus] = useState<Focus>(null);
  const agentLit = (slot: number): boolean => {
    if (!focus) return true;
    if (focus.kind === 'agent') return focus.slot === slot;
    return agentIds.some(
      (id, i) =>
        layout.agentSlot[i] === slot &&
        [...(reach.get(id) ?? [])].some((m) => layout.memberSlot[m] === focus.slot),
    );
  };
  const memberLit = (slot: number): boolean => {
    if (!focus) return true;
    if (focus.kind === 'member') return focus.slot === slot;
    return agentIds.some(
      (id, i) =>
        layout.agentSlot[i] === focus.slot &&
        [...(reach.get(id) ?? [])].some((m) => layout.memberSlot[m] === slot),
    );
  };

  const anyCooling = (status?.members ?? []).some((m) => m.coolingUntil !== null);
  const now = useTickingNow(anyCooling);

  // Pulses (or, with reduced motion, a brief highlight) for this group's share of a batch.
  const layerRef = useRef<SVGGElement>(null);
  const live = useRef({ layout, agentIds, t });
  live.current = { layout, agentIds, t };
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  useEffect(() => {
    const mine = batch.pulses.filter((p) => p.groupId === group.id);
    if (mine.length === 0) return;
    if (reduced) {
      const last = mine[mine.length - 1]!;
      const ai = live.current.agentIds.indexOf(last.agentId);
      setHighlight({
        agentSlot: ai >= 0 ? live.current.layout.agentSlot[ai]! : -1,
        memberSlots: last.hops
          .filter((h) => h.memberIndex >= 0)
          .map((h) => live.current.layout.memberSlot[h.memberIndex]!),
        ok: last.ok,
      });
      const id = window.setTimeout(() => setHighlight(null), motion.flowHighlight);
      return () => window.clearTimeout(id);
    }
    const layer = layerRef.current;
    if (!layer) return;
    for (const p of mine) void playPulse(layer, p, live);
    return undefined;
  }, [batch.seq]); // one run per batch: the rest is read through `live`
  useEffect(() => {
    const layer = layerRef.current;
    return () => {
      if (!layer) return;
      for (const a of layer.getAnimations?.({ subtree: true }) ?? []) a.cancel();
      layer.replaceChildren();
    };
  }, []);

  const L = layout;
  const g = L.group;
  const idle = (status?.lastHour.requests ?? 0) === 0 && !recent.some((d) => d.groupId === group.id);
  const hourText =
    status && status.lastHour.requests > 0
      ? t('providers.routingStatus.summary')
          .replace('{{count}}', String(status.lastHour.requests))
          .replace('{{failovers}}', String(status.lastHour.failovers))
      : t('providers.routingStatus.noTraffic');

  return (
    <div ref={boxRef} style={{ position: 'relative', minHeight: L.height }}>
      <p className="sr-only">{`${group.name}: ${hourText}`}</p>
      {width > 0 && (
        <svg
          aria-hidden
          width={L.width}
          height={L.height}
          viewBox={`0 0 ${L.width} ${L.height}`}
          style={{ display: 'block', overflow: 'visible' }}
          onMouseLeave={() => setFocus(null)}
        >
          {/* Edges: Agent → routing group */}
          {L.agents.map((a, slot) => (
            <path
              key={`ae-${a.key}`}
              d={edgePath(a.x, a.y, g.x, g.y)}
              fill="none"
              style={edgeStyle(idle, agentWeights[slot] ?? 0, 'accent', agentLit(slot))}
            />
          ))}
          {/* Edges: routing group → member */}
          {L.members.map((m, slot) => (
            <path
              key={`me-${m.key}`}
              d={edgePath(g.x, g.y, m.x, m.y)}
              fill="none"
              style={edgeStyle(
                idle,
                memberWeights[slot] ?? 0,
                FLOW_MEMBER_COLORS[slot % FLOW_MEMBER_COLORS.length]!,
                memberLit(slot),
              )}
            />
          ))}
          {/* Reduced motion: the newest path, highlighted for a moment */}
          {highlight && (
            <g style={{ pointerEvents: 'none' }}>
              {highlight.agentSlot >= 0 && L.agents[highlight.agentSlot] && (
                <path
                  d={edgePath(L.agents[highlight.agentSlot]!.x, L.agents[highlight.agentSlot]!.y, g.x, g.y)}
                  fill="none"
                  style={{ stroke: token('accent'), strokeWidth: 3 }}
                />
              )}
              {highlight.memberSlots.map((slot, i) =>
                L.members[slot] ? (
                  <path
                    key={i}
                    d={edgePath(g.x, g.y, L.members[slot]!.x, L.members[slot]!.y)}
                    fill="none"
                    style={{
                      stroke: token(i === highlight.memberSlots.length - 1 && highlight.ok ? 'success' : 'danger'),
                      strokeWidth: 3,
                    }}
                  />
                ) : null,
              )}
            </g>
          )}

          {/* Agent nodes */}
          {L.agents.map((a, slot) => (
            <g
              key={`a-${a.key}`}
              onMouseEnter={() => setFocus({ kind: 'agent', slot })}
              style={{ opacity: agentLit(slot) ? 1 : 0.35, cursor: 'default' }}
            >
              <circle cx={a.x} cy={a.y} r={4} style={{ fill: token(a.overflow ? 'textMuted' : 'text') }} />
              <text
                x={a.x - 10}
                y={a.y}
                textAnchor="end"
                dominantBaseline="central"
                style={{ fontSize: fontSize.sm, fill: token(a.overflow ? 'textMuted' : 'text') }}
              >
                {fitLabel(a.label, L.agentLabelWidth)}
              </text>
            </g>
          ))}
          {L.agents.length === 0 && (
            <text
              x={g.x - 30}
              y={g.y}
              textAnchor="end"
              dominantBaseline="central"
              style={{ fontSize: fontSize.sm, fill: token('textMuted') }}
            >
              {t('providers.routingFlow.noAgents')}
            </text>
          )}

          {/* Routing group node */}
          <g onClick={onOpenRecent} style={{ cursor: 'pointer' }}>
            <circle cx={g.x} cy={g.y} r={14} style={{ fill: 'transparent' }} />
            <circle cx={g.x} cy={g.y} r={7} style={{ fill: token('accent') }} />
            <circle cx={g.x} cy={g.y} r={11} style={{ fill: 'none', stroke: token('accent'), strokeOpacity: 0.35 }} />
            <text
              x={g.x}
              y={g.y + 24}
              textAnchor="middle"
              style={{ fontSize: fontSize.sm, fontWeight: 600, fill: token('text') }}
            >
              {fitLabel(group.name, Math.max(80, ((L.members[0]?.x ?? g.x + 100) - g.x) * 1.6))}
            </text>
            <text
              x={g.x}
              y={g.y + 38}
              textAnchor="middle"
              style={{ fontSize: fontSize.xs, fill: token('textMuted') }}
            >
              {t(`providers.routingGroup.strategies.${group.strategy}`)}
              {group.affinity === 'session' && (status?.pinnedSessions ?? 0) > 0
                ? ` · ${t('providers.routingFlow.pinnedShort').replace('{{count}}', String(status?.pinnedSessions ?? 0))}`
                : ''}
            </text>
          </g>

          {/* Member nodes */}
          {L.members.map((m, slot) => {
            const live = m.overflow ? undefined : status?.members[slot];
            const coolingLeft =
              live?.coolingUntil && live.coolingUntil > now ? live.coolingUntil - now : 0;
            const ring = coolingLeft > 0 ? Math.min(1, coolingLeft / ROUTING_COOLDOWN_MS) : 0;
            const right = coolingLeft
              ? t('providers.routingStatus.cooling').replace('{{s}}', String(Math.ceil(coolingLeft / 1000)))
              : live?.next
                ? t('providers.routingStatus.next')
                : live && live.okCount > 0
                  ? t('providers.routingStatus.okCount').replace('{{count}}', String(live.okCount))
                  : '';
            return (
              <g
                key={`m-${m.key}`}
                onMouseEnter={() => setFocus({ kind: 'member', slot })}
                onClick={onOpenRecent}
                style={{ opacity: memberLit(slot) ? 1 : 0.35, cursor: 'pointer' }}
              >
                <circle
                  cx={m.x}
                  cy={m.y}
                  r={5}
                  style={{
                    fill: token(
                      m.overflow ? 'textMuted' : FLOW_MEMBER_COLORS[slot % FLOW_MEMBER_COLORS.length]!,
                    ),
                  }}
                />
                {live?.next && !coolingLeft && (
                  <circle cx={m.x} cy={m.y} r={8.5} style={{ fill: 'none', stroke: token('accent'), strokeWidth: 1.5 }} />
                )}
                {ring > 0 && (
                  <circle
                    cx={m.x}
                    cy={m.y}
                    r={8.5}
                    pathLength={100}
                    transform={`rotate(-90 ${m.x} ${m.y})`}
                    style={{
                      fill: 'none',
                      stroke: token('warning'),
                      strokeWidth: 2,
                      strokeDasharray: `${(ring * 100).toFixed(1)} 100`,
                    }}
                  />
                )}
                <text
                  x={m.x + 14}
                  y={m.y}
                  dominantBaseline="central"
                  style={{ fontSize: fontSize.sm, fill: token(m.overflow ? 'textMuted' : 'text') }}
                >
                  {fitLabel(m.label, L.memberLabelWidth)}
                </text>
                {right && (
                  <text
                    x={L.width - 4}
                    y={m.y}
                    textAnchor="end"
                    dominantBaseline="central"
                    style={{
                      fontSize: fontSize.xs,
                      fill: token(live?.next && !coolingLeft ? 'accent' : 'textMuted'),
                    }}
                  >
                    {right}
                  </text>
                )}
              </g>
            );
          })}

          {/* Pulses are appended here imperatively (see playPulse) */}
          <g ref={layerRef} style={{ pointerEvents: 'none' }} />
        </svg>
      )}
    </div>
  );
}

function edgeStyle(idle: boolean, share: number, color: TokenName, lit: boolean) {
  if (idle || share === 0) {
    return {
      stroke: token('borderStrong'),
      strokeWidth: 1.25,
      strokeDasharray: '3 4',
      opacity: lit ? 0.7 : 0.25,
    };
  }
  return {
    stroke: token(color),
    strokeWidth: 1.5 + share * 4.5,
    strokeLinecap: 'round' as const,
    opacity: (lit ? 0.35 + share * 0.5 : 0.12),
    transition: 'stroke-width 300ms, opacity 200ms',
  };
}

// ─── Pulse playback (imperative; the static diagram never re-renders for it) ───────────

type Live = React.RefObject<{ layout: FlowLayout; agentIds: AgentId[]; t: TranslateFn }>;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

async function done(a: Animation): Promise<boolean> {
  try {
    await a.finished;
    return true;
  } catch {
    return false; // cancelled (unmount)
  }
}

function travel(el: SVGElement, pts: { x: number; y: number }[], duration: number): Animation {
  return el.animate(
    pts.map((p) => ({ transform: `translate(${p.x}px, ${p.y}px)` })),
    { duration, easing: motion.flowEase, fill: 'forwards' },
  );
}

/** A ring that grows and fades at a node (success / failure mark). */
function halo(layer: SVGGElement, x: number, y: number, color: TokenName): void {
  const c = svgEl('circle', { cx: 0, cy: 0, r: 6 });
  c.style.fill = 'none';
  c.style.stroke = token(color);
  c.style.strokeWidth = '2';
  c.style.transformBox = 'fill-box';
  c.style.transformOrigin = 'center';
  const wrap = svgEl('g', { transform: `translate(${x} ${y})` });
  wrap.append(c);
  layer.append(wrap);
  const a = c.animate(
    [
      { transform: 'scale(1)', opacity: 0.9 },
      { transform: 'scale(2.4)', opacity: 0 },
    ],
    { duration: motion.flowMark, easing: 'ease-out', fill: 'forwards' },
  );
  void done(a).then(() => wrap.remove());
}

/** A short text tag next to a node ("✕ 429"), fading out. */
function tag(layer: SVGGElement, x: number, y: number, text: string, color: TokenName): void {
  const el = svgEl('text', { x, y, 'text-anchor': 'end' });
  el.textContent = text;
  el.style.fill = token(color);
  el.style.fontSize = `${fontSize.xs}px`;
  el.style.fontWeight = '600';
  layer.append(el);
  const a = el.animate(
    [
      { opacity: 0, transform: 'translateY(3px)' },
      { opacity: 1, transform: 'translateY(0)', offset: 0.2 },
      { opacity: 1, offset: 0.7 },
      { opacity: 0, transform: 'translateY(-3px)' },
    ],
    { duration: motion.flowMark * 1.6, easing: 'ease-out', fill: 'forwards' },
  );
  void done(a).then(() => el.remove());
}

/** Briefly paint a failed hop's edge red. */
function flashEdge(layer: SVGGElement, d: string): void {
  const p = svgEl('path', { d, fill: 'none' });
  p.style.stroke = token('danger');
  p.style.strokeWidth = '2.5';
  p.style.strokeLinecap = 'round';
  layer.prepend(p);
  const a = p.animate([{ opacity: 0.9 }, { opacity: 0 }], {
    duration: motion.flowMark,
    easing: 'ease-in',
    fill: 'forwards',
  });
  void done(a).then(() => p.remove());
}

async function playPulse(layer: SVGGElement, pulse: FlowPulse, live: Live): Promise<void> {
  const { layout: L, agentIds, t } = live.current;
  const g = L.group;
  const ai = agentIds.indexOf(pulse.agentId);
  const from = ai >= 0 ? L.agents[L.agentSlot[ai]!] : undefined;
  const start = from ?? { x: Math.max(0, g.x - 120), y: g.y };

  const dot = svgEl('g', {});
  const core = svgEl('circle', { cx: 0, cy: 0, r: 4.5 });
  core.style.fill = token('accent');
  core.style.stroke = token('bg');
  core.style.strokeWidth = '1.5';
  dot.append(core);
  if (pulse.count > 1) {
    const n = svgEl('text', { x: 7, y: -6 });
    n.textContent = `×${pulse.count}`;
    n.style.fontSize = '10px';
    n.style.fontWeight = '600';
    n.style.fill = token('textMuted');
    dot.append(n);
  }
  dot.style.opacity = '0';
  layer.append(dot);
  dot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, fill: 'forwards' });

  try {
    if (!(await done(travel(dot, edgePoints(start.x, start.y, g.x, g.y), motion.flowHop)))) return;
    for (let i = 0; i < pulse.hops.length; i++) {
      const hop = pulse.hops[i]!;
      const m = hop.memberIndex >= 0 ? L.members[L.memberSlot[hop.memberIndex]!] : undefined;
      if (!m) break; // member since removed: the pulse ends at the group
      core.style.fill = token('accent');
      if (!(await done(travel(dot, edgePoints(g.x, g.y, m.x, m.y), motion.flowHop)))) return;
      if (hop.ok) {
        core.style.fill = token('success');
        halo(layer, m.x, m.y, 'success');
        break;
      }
      core.style.fill = token('danger');
      flashEdge(layer, edgePath(g.x, g.y, m.x, m.y));
      tag(
        layer,
        m.x - 10,
        m.y - 9,
        `✕ ${hop.status === 0 ? t('providers.routingStatus.unreachable') : hop.status}`,
        'danger',
      );
      halo(layer, m.x, m.y, 'danger');
      if (i < pulse.hops.length - 1) {
        // Failover: the next attempt leaves from the routing group again.
        await done(dot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: 'forwards' }));
        dot.animate([{ transform: `translate(${g.x}px, ${g.y}px)` }], { duration: 0, fill: 'forwards' });
        dot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, fill: 'forwards' });
      }
    }
    if (!pulse.ok) halo(layer, g.x, g.y, 'danger');
    await done(
      dot.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: motion.flowMark / 2,
        delay: 120,
        fill: 'forwards',
      }),
    );
  } finally {
    dot.remove();
  }
}

const panelStyle = {
  background: token('surface'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.lg,
  padding: `${space.md}px ${space.lg}px`,
  marginBottom: space.lg,
} as const;

const toggleStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: space.xs,
  border: 'none',
  background: 'transparent',
  color: token('text'),
  fontSize: fontSize.base,
  fontWeight: 600,
  padding: `2px ${space.sm}px`,
  marginLeft: -space.sm,
  borderRadius: radius.sm,
  cursor: 'pointer',
} as const;
