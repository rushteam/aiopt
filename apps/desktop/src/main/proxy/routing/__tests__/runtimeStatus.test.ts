import { describe, expect, it } from 'vitest';
import { createRoutingRuntime } from '../runtime';
import { createSessionAffinityStore } from '../sessionAffinity';
import type { RoutingGroup } from '../../../../shared/routingGroups';
import { ROUTING_RECENT_MAX, ROUTING_SUMMARY_WINDOW_MS } from '../../../../shared/routingStatus';

const group: RoutingGroup = {
  id: 'g1',
  name: 'g',
  members: [
    { providerId: 'p1', modelId: 'm1' },
    { providerId: 'p2', modelId: 'm2' },
  ],
  strategy: 'rotate',
  affinity: 'session',
  createdAt: 1,
};

function runtime(groups: RoutingGroup[] = [group]) {
  const affinity = createSessionAffinityStore();
  const rt = createRoutingRuntime({
    getGroup: (id) => groups.find((g) => g.id === id) ?? null,
    listGroups: () => groups,
    lookups: { getProvider: () => null, getAgentDef: () => null },
    affinity,
  });
  return { rt, affinity };
}

const failover = (now: number) => ({
  groupId: 'g1',
  agentId: 'claude' as const,
  strategy: 'rotate' as const,
  sticky: false,
  attempts: [
    { providerId: 'p1', modelId: 'm1', status: 429, ok: false, ms: 120 },
    { providerId: 'p2', modelId: 'm2', status: 200, ok: true, ms: 1800 },
  ],
  ok: true,
  ms: 1920,
});

describe('routing runtime status', () => {
  it('reports cooldown, counts, rotate cursor and a pinned-session count', () => {
    const { rt } = runtime();
    rt.onFailover('p1\u241fm1');
    rt.onSuccess('g1', 'conv-secret-key', 'p2\u241fm2');
    const now = Date.now();
    rt.recordDecision!(failover(now), now);
    const snap = rt.status!(now);
    const g = snap.groups[0]!;
    expect(g.members[0]!.coolingUntil).toBeGreaterThan(now);
    expect(g.members[1]!.coolingUntil).toBeNull();
    expect(g.members[1]!.okCount).toBe(1);
    expect(g.members[0]!.lastFailStatus).toBe(429);
    expect(g.members[1]!.lastOkAt).toBe(now);
    // rotate advanced once → member 2 starts the next request
    expect(g.members.map((m) => m.next)).toEqual([false, true]);
    expect(g.pinnedSessions).toBe(1);
    expect(g.lastHour).toEqual({ requests: 1, failovers: 1, hits: [0, 1] });
    // The conversation key never reaches the snapshot.
    expect(JSON.stringify(snap)).not.toContain('conv-secret-key');
  });

  it('keeps only the newest ROUTING_RECENT_MAX decisions, newest first', () => {
    const { rt } = runtime();
    const now = Date.now();
    for (let i = 0; i < ROUTING_RECENT_MAX + 5; i++) rt.recordDecision!(failover(now + i), now + i);
    const { recent } = rt.status!(now + ROUTING_RECENT_MAX + 5);
    expect(recent).toHaveLength(ROUTING_RECENT_MAX);
    expect(recent[0]!.at).toBeGreaterThan(recent[1]!.at);
  });

  it('drops extra fields a caller passes (content-free by construction)', () => {
    const { rt } = runtime();
    const input = failover(1) as ReturnType<typeof failover> & { body?: string };
    input.body = 'secret prompt';
    (input.attempts[0] as unknown as Record<string, unknown>).reply = 'secret reply';
    rt.recordDecision!(input, 1);
    const text = JSON.stringify(rt.status!(1));
    expect(text).not.toContain('secret');
  });

  it('the last-hour summary forgets requests outside the window', () => {
    const { rt } = runtime();
    rt.recordDecision!(failover(0), 1000);
    expect(rt.status!(1000 + ROUTING_SUMMARY_WINDOW_MS + 1).groups[0]!.lastHour.requests).toBe(0);
  });

  it('retryNow lifts a cooling member of that group only', () => {
    const { rt } = runtime();
    rt.onFailover('p1\u241fm1');
    expect(rt.retryNow!('g1', 'p9', 'm9')).toBe(false);
    expect(rt.retryNow!('nope', 'p1', 'm1')).toBe(false);
    expect(rt.retryNow!('g1', 'p1', 'm1')).toBe(true);
    expect(rt.cooldown.isResting('p1\u241fm1')).toBe(false);
    expect(rt.retryNow!('g1', 'p1', 'm1')).toBe(false);
  });

  it('notifies listeners on failover, decisions and retryNow', () => {
    const { rt } = runtime();
    let n = 0;
    const off = rt.onStatusChange!(() => (n += 1));
    rt.onFailover('p1\u241fm1');
    rt.recordDecision!(failover(1), 1);
    rt.retryNow!('g1', 'p1', 'm1');
    expect(n).toBe(3);
    off();
    rt.onFailover('p1\u241fm1');
    expect(n).toBe(3);
  });

  it('clearGroup drops the group from recent', () => {
    const { rt } = runtime();
    rt.recordDecision!(failover(1), 1);
    rt.clearGroup('g1');
    expect(rt.status!(2).recent).toHaveLength(0);
  });
});
