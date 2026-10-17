import { describe, expect, it } from 'vitest';
import {
  applyAffinityOrder,
  candidateSeat,
  deferCooling,
  orderMemberIndexes,
} from '../../../../shared/routingGroups';
import { planRoutingOrder, type ResolvedMember } from '../plan';

const members: ResolvedMember[] = [
  {
    providerId: 'p1',
    modelId: 'm1',
    outboundFormat: 'openai',
    upstreamBaseUrl: 'https://a.example',
    wireModelId: 'm1',
  },
  {
    providerId: 'p2',
    modelId: 'm2',
    outboundFormat: 'openai',
    upstreamBaseUrl: 'https://b.example',
    wireModelId: 'm2',
  },
  {
    providerId: 'p3',
    modelId: 'm3',
    outboundFormat: 'anthropic',
    upstreamBaseUrl: 'https://c.example',
    wireModelId: 'm3',
  },
];

describe('orderMemberIndexes', () => {
  it('ordered keeps declaration order', () => {
    expect(orderMemberIndexes('ordered', 3)).toEqual([0, 1, 2]);
  });

  it('rotate starts at the cursor', () => {
    expect(orderMemberIndexes('rotate', 3, { rotateCursor: 1 })).toEqual([1, 2, 0]);
    expect(orderMemberIndexes('rotate', 3, { rotateCursor: 5 })).toEqual([2, 0, 1]);
  });

  it('least_used prefers the seat with fewer ok replies', () => {
    const seats = members.map((m) => candidateSeat(m.providerId, m.modelId));
    const usage = new Map([
      [seats[0]!, 5],
      [seats[1]!, 1],
      [seats[2]!, 1],
    ]);
    expect(orderMemberIndexes('least_used', 3, { seats, usageBySeat: usage })).toEqual([1, 2, 0]);
  });
});

describe('applyAffinityOrder / deferCooling', () => {
  it('moves the sticky seat first when present', () => {
    expect(applyAffinityOrder([0, 1, 2], 2)).toEqual([2, 0, 1]);
    expect(applyAffinityOrder([0, 1, 2], null)).toEqual([0, 1, 2]);
  });

  it('defers cooling seats without dropping them', () => {
    const seats = ['a', 'b', 'c'];
    expect(deferCooling([0, 1, 2], seats, new Set(['a']))).toEqual([1, 2, 0]);
    expect(deferCooling([0, 1, 2], seats, new Set(['a', 'b', 'c']))).toEqual([0, 1, 2]);
  });
});

describe('planRoutingOrder', () => {
  it('session affinity then cooldown shape the try order', () => {
    const seats = members.map((m) => candidateSeat(m.providerId, m.modelId));
    const sticky = seats[2]!;
    const { order, candidates } = planRoutingOrder({
      members,
      strategy: 'ordered',
      affinity: 'session',
      stickySeat: sticky,
      cooling: new Set([sticky]),
      usageBySeat: new Map(),
      rotateCursor: 0,
    });
    // Sticky would be first, but it is cooling → deferred to the back.
    expect(order).toEqual([0, 1, 2]);
    expect(candidates.map((c) => c.providerId)).toEqual(['p1', 'p2', 'p3']);
  });

  it('rotate + sticky puts sticky first among ready seats', () => {
    const seats = members.map((m) => candidateSeat(m.providerId, m.modelId));
    const { order } = planRoutingOrder({
      members,
      strategy: 'rotate',
      affinity: 'session',
      stickySeat: seats[0]!,
      cooling: new Set(),
      usageBySeat: new Map(),
      rotateCursor: 1, // natural rotate: 1,2,0
    });
    expect(order).toEqual([0, 1, 2]);
  });
});
