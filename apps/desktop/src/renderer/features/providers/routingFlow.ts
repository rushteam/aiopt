// Pure geometry + bookkeeping for the routing-flow panel (RoutingFlowPanel.tsx).
//
// No DOM, no timers: the panel feeds it the status snapshot and draws what comes back,
// so the parts that decide WHAT moves (which decisions are new, how they coalesce, where
// the nodes sit) are unit-testable without a browser. Inputs are the content-free status
// snapshot only — ids, status codes and times.

import type { AgentId } from '../../../shared/aiProviders';
import type { RoutingGroupSummary } from '../../../shared/routingGroups';
import type { RoutingDecision } from '../../../shared/routingStatus';

/** Visible nodes per column; past this the tail folds into one "+N" node. */
export const FLOW_MAX_NODES = 8;
/** Pulses in flight at once; more are dropped (never queued — the drawer has the history). */
export const FLOW_MAX_PULSES = 12;

const ROW_HEIGHT = 30;
const PAD_Y = 18;

export interface FlowLabel {
  key: string;
  label: string;
}

export interface FlowNode extends FlowLabel {
  x: number;
  y: number;
  /** For the "+N" fold node: how many entries it stands for. */
  overflow?: number;
}

export interface FlowLayout {
  width: number;
  height: number;
  agents: FlowNode[];
  group: { x: number; y: number };
  members: FlowNode[];
  /** Input index → visible node index (folded entries map to the "+N" node). */
  agentSlot: number[];
  memberSlot: number[];
  /** Pixel budget for a member label (it runs from the member dot toward the status column). */
  memberLabelWidth: number;
  agentLabelWidth: number;
}

/**
 * Agents to draw for a group: those currently bound to it (in snapshot order), then any
 * that still show up in its recent decisions (a binding moved away keeps its history).
 */
export function flowAgentIds(
  group: RoutingGroupSummary,
  agents: { id: AgentId; binding: { providerId: string } | null }[],
  recent: RoutingDecision[],
): AgentId[] {
  const out: AgentId[] = [];
  for (const a of agents) if (a.binding?.providerId === group.virtualProviderId) out.push(a.id);
  for (const d of recent) if (d.groupId === group.id && !out.includes(d.agentId)) out.push(d.agentId);
  return out;
}

function column(
  items: FlowLabel[],
  x: number,
  centerY: number,
  moreLabel: (n: number) => string,
): { nodes: FlowNode[]; slot: number[] } {
  const fold = items.length > FLOW_MAX_NODES;
  const shown = fold ? items.slice(0, FLOW_MAX_NODES - 1) : items;
  const labels: (FlowLabel & { overflow?: number })[] = shown.map((i) => ({ ...i }));
  if (fold) {
    const n = items.length - shown.length;
    labels.push({ key: '__more__', label: moreLabel(n), overflow: n });
  }
  const top = centerY - ((labels.length - 1) * ROW_HEIGHT) / 2;
  const nodes = labels.map((l, i) => ({ ...l, x, y: Math.round(top + i * ROW_HEIGHT) }));
  const slot = items.map((_, i) => Math.min(i, nodes.length - 1));
  return { nodes, slot };
}

/** Three columns — Agents · routing group · members — sized to `width`. */
export function layoutFlow(
  width: number,
  agents: FlowLabel[],
  members: FlowLabel[],
  moreLabel: (n: number) => string,
): FlowLayout {
  const w = Math.max(320, Math.round(width));
  const rows = Math.max(1, Math.min(FLOW_MAX_NODES, Math.max(agents.length, members.length)));
  const height = rows * ROW_HEIGHT + PAD_Y * 2 + 12; // +12: room for the group's meta line
  const centerY = Math.round(PAD_Y + ((rows - 1) * ROW_HEIGHT) / 2) + 2;
  const xA = Math.round(w * 0.27);
  const xG = Math.round(w * 0.47);
  const xM = Math.round(w * 0.64);
  const a = column(agents, xA, centerY, moreLabel);
  const m = column(members, xM, centerY, moreLabel);
  return {
    width: w,
    height,
    agents: a.nodes,
    agentSlot: a.slot,
    group: { x: xG, y: centerY },
    members: m.nodes,
    memberSlot: m.slot,
    agentLabelWidth: xA - 22,
    memberLabelWidth: Math.max(60, w - xM - 12 - 96),
  };
}

/** A horizontal S-curve from one node to the next. */
export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

/** Cut `text` to roughly `px` wide at the body size (avg glyph ≈ 6.6px; CJK ≈ 12px). */
export function fitLabel(text: string, px: number): string {
  let width = 0;
  let out = '';
  for (const ch of text) {
    const w = /[\u2e80-\uffff]/.test(ch) ? 12 : 6.6;
    if (width + w > px) return `${out.replace(/\s+$/, '')}…`;
    width += w;
    out += ch;
  }
  return out;
}

/**
 * Decisions newer than `lastSeenId` (oldest first, so pulses play in order). `recent` is
 * newest first. Ids are monotonic within a run; a lower max means the main process
 * restarted, so everything is treated as already seen rather than replayed.
 */
export function takeNewDecisions(
  recent: RoutingDecision[],
  lastSeenId: number | null,
): { fresh: RoutingDecision[]; lastSeenId: number } {
  const maxId = recent.reduce((m, d) => Math.max(m, d.id), 0);
  if (lastSeenId === null || maxId < lastSeenId) return { fresh: [], lastSeenId: maxId };
  const fresh = recent.filter((d) => d.id > lastSeenId).sort((x, y) => x.id - y.id);
  return { fresh, lastSeenId: maxId };
}

export interface FlowHop {
  /** Index into the group's members; -1 when the member has since been removed. */
  memberIndex: number;
  ok: boolean;
  status: number;
}

export interface FlowPulse {
  groupId: string;
  agentId: AgentId;
  hops: FlowHop[];
  ok: boolean;
  /** Identical decisions folded into this one pulse (shown as "×N"). */
  count: number;
}

/** One pulse per distinct path in a batch, capped at `cap` (extra paths are dropped). */
export function coalescePulses(
  fresh: RoutingDecision[],
  groups: RoutingGroupSummary[],
  cap: number = FLOW_MAX_PULSES,
): FlowPulse[] {
  const byKey = new Map<string, FlowPulse>();
  for (const d of fresh) {
    const group = groups.find((g) => g.id === d.groupId);
    if (!group) continue;
    const hops = d.attempts.map((a) => ({
      memberIndex: group.members.findIndex((m) => m.providerId === a.providerId && m.modelId === a.modelId),
      ok: a.ok,
      status: a.status,
    }));
    const key = `${d.groupId}|${d.agentId}|${hops.map((h) => `${h.memberIndex}:${h.ok ? 1 : 0}:${h.status}`).join(',')}`;
    const hit = byKey.get(key);
    if (hit) hit.count += 1;
    else if (byKey.size < cap) byKey.set(key, { groupId: d.groupId, agentId: d.agentId, hops, ok: d.ok, count: 1 });
  }
  return [...byKey.values()];
}

/** Share (0..1) of each entry in `counts`; all zero when there is no traffic. */
export function shares(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  return counts.map((c) => (total > 0 ? c / total : 0));
}

/** Which member indexes each Agent has reached in the recent decisions (for hover focus). */
export function agentReach(groupId: string, group: RoutingGroupSummary, recent: RoutingDecision[]) {
  const reach = new Map<AgentId, Set<number>>();
  for (const d of recent) {
    if (d.groupId !== groupId) continue;
    let set = reach.get(d.agentId);
    if (!set) reach.set(d.agentId, (set = new Set()));
    for (const a of d.attempts) {
      const i = group.members.findIndex((m) => m.providerId === a.providerId && m.modelId === a.modelId);
      if (i >= 0) set.add(i);
    }
  }
  return reach;
}

/** Persisted "panel collapsed" choice; null = never chosen (auto: open once there is traffic). */
export const ROUTING_FLOW_COLLAPSED_KEY = 'providers.routingFlow.collapsed';

export function resolveFlowCollapsed(stored: string | null, hasTraffic: boolean): boolean {
  if (stored === '1') return true;
  if (stored === '0') return false;
  return !hasTraffic;
}

/** Points along {@link edgePath}'s curve (for transform keyframes; no DOM geometry needed). */
export function edgePoints(x1: number, y1: number, x2: number, y2: number, steps = 16): { x: number; y: number }[] {
  const mx = (x1 + x2) / 2;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    // Cubic Bézier with control points (mx, y1) and (mx, y2).
    const x = u * u * u * x1 + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * x2;
    const y = u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2;
    out.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  }
  return out;
}
