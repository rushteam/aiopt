import { describe, expect, it } from 'vitest';
import {
  coalescePulses,
  edgePoints,
  fitLabel,
  flowAgentIds,
  FLOW_MAX_NODES,
  layoutFlow,
  resolveFlowCollapsed,
  shares,
  takeNewDecisions,
} from '../routingFlow';
import type { RoutingGroupSummary } from '../../../../shared/routingGroups';
import type { RoutingDecision } from '../../../../shared/routingStatus';

const group: RoutingGroupSummary = {
  id: 'g1',
  name: 'G',
  virtualProviderId: '__rg__g1',
  strategy: 'ordered',
  affinity: 'off',
  createdAt: 1,
  members: [
    { providerId: 'p1', modelId: 'm1' },
    { providerId: 'p2', modelId: 'm2' },
  ],
};

function decision(id: number, over: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    id,
    at: id,
    groupId: 'g1',
    agentId: 'claude',
    strategy: 'ordered',
    sticky: false,
    ok: true,
    ms: 10,
    attempts: [{ providerId: 'p1', modelId: 'm1', status: 200, ok: true, ms: 10 }],
    ...over,
  };
}

describe('routing flow — new decisions', () => {
  it('the first snapshot only primes the mark (no replay of history)', () => {
    expect(takeNewDecisions([decision(3), decision(2)], null)).toEqual({ fresh: [], lastSeenId: 3 });
  });

  it('returns only newer decisions, oldest first', () => {
    const r = takeNewDecisions([decision(5), decision(4), decision(3)], 3);
    expect(r.fresh.map((d) => d.id)).toEqual([4, 5]);
    expect(r.lastSeenId).toBe(5);
  });

  it('treats a lower id (main restarted) as already seen', () => {
    expect(takeNewDecisions([decision(2)], 40)).toEqual({ fresh: [], lastSeenId: 2 });
  });
});

describe('routing flow — pulses', () => {
  it('folds identical paths into one pulse with a count', () => {
    const pulses = coalescePulses([decision(1), decision(2), decision(3, { agentId: 'codex' })], [group]);
    expect(pulses).toHaveLength(2);
    expect(pulses[0]).toMatchObject({ agentId: 'claude', count: 2 });
  });

  it('maps a failover trail onto member indexes; unknown members become -1', () => {
    const [p] = coalescePulses(
      [
        decision(1, {
          attempts: [
            { providerId: 'p1', modelId: 'm1', status: 429, ok: false, ms: 1 },
            { providerId: 'gone', modelId: 'x', status: 0, ok: false, ms: 1 },
            { providerId: 'p2', modelId: 'm2', status: 200, ok: true, ms: 1 },
          ],
        }),
      ],
      [group],
    );
    expect(p!.hops).toEqual([
      { memberIndex: 0, ok: false, status: 429 },
      { memberIndex: -1, ok: false, status: 0 },
      { memberIndex: 1, ok: true, status: 200 },
    ]);
  });

  it('drops (never queues) paths past the cap, and decisions of unknown groups', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      decision(i + 1, { attempts: [{ providerId: "p1", modelId: "m1", status: 500 + i, ok: false, ms: 1 }] }),
    );
    expect(coalescePulses(many, [group], 5)).toHaveLength(5);
    expect(coalescePulses([decision(1, { groupId: 'nope' })], [group])).toEqual([]);
  });
});

describe('routing flow — layout', () => {
  it('lists bound Agents first, then ones only seen in history', () => {
    const ids = flowAgentIds(
      group,
      [
        { id: 'codex', binding: { providerId: '__rg__g1' } },
        { id: 'claude', binding: { providerId: 'other' } },
      ],
      [decision(1, { agentId: 'claude' }), decision(2, { agentId: 'codex' })],
    );
    expect(ids).toEqual(['codex', 'claude']);
  });

  it('folds columns past FLOW_MAX_NODES into a "+N" node', () => {
    const members = Array.from({ length: 11 }, (_, i) => ({ key: `m${i}`, label: `m${i}` }));
    const l = layoutFlow(900, [{ key: 'a', label: 'A' }], members, (n) => `+${n}`);
    expect(l.members).toHaveLength(FLOW_MAX_NODES);
    expect(l.members.at(-1)).toMatchObject({ label: '+4', overflow: 4 });
    expect(l.memberSlot[10]).toBe(FLOW_MAX_NODES - 1);
    expect(l.memberSlot[2]).toBe(2);
    // columns ordered left → right, group centered vertically among members
    expect(l.agents[0]!.x).toBeLessThan(l.group.x);
    expect(l.group.x).toBeLessThan(l.members[0]!.x);
  });

  it('edge points start and end on the nodes', () => {
    const pts = edgePoints(0, 0, 100, 40);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts.at(-1)).toEqual({ x: 100, y: 40 });
  });

  it('fits labels to a pixel budget', () => {
    expect(fitLabel('short', 200)).toBe('short');
    expect(fitLabel('a-very-long-provider/model-name', 60).endsWith('…')).toBe(true);
  });

  it('shares are zero with no traffic', () => {
    expect(shares([0, 0])).toEqual([0, 0]);
    expect(shares([1, 3])).toEqual([0.25, 0.75]);
  });

  it('collapsed: the user choice wins, else open only once there is traffic', () => {
    expect(resolveFlowCollapsed(null, false)).toBe(true);
    expect(resolveFlowCollapsed(null, true)).toBe(false);
    expect(resolveFlowCollapsed('1', true)).toBe(true);
    expect(resolveFlowCollapsed('0', false)).toBe(false);
  });
});
