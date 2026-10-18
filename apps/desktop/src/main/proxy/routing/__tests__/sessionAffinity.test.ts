import { describe, expect, it } from 'vitest';
import { createSessionAffinityStore } from '../sessionAffinity';
import { ROUTING_AFFINITY_TTL_MS } from '../../../../shared/routingGroups';

describe('sessionAffinityStore', () => {
  it('remembers and returns a stick', () => {
    const saved: unknown[] = [];
    const store = createSessionAffinityStore({
      load: () => ({}),
      save: (sticks) => {
        saved.push(sticks);
      },
    });
    store.remember('g1', 'c1', 'p1\u241fm1', 1000);
    expect(store.get('g1', 'c1', 1000)).toBe('p1\u241fm1');
    expect(saved).toHaveLength(1);
  });

  it('expires sticks past TTL and clearGroup drops them', () => {
    const store = createSessionAffinityStore({
      load: () => ({
        sticks: [
          { conversationKey: 'c1', groupId: 'g1', seat: 'a', at: 1 },
          { conversationKey: 'c2', groupId: 'g2', seat: 'b', at: 1 },
        ],
      }),
      save: () => {},
    });
    expect(store.get('g1', 'c1', 1 + ROUTING_AFFINITY_TTL_MS + 1)).toBeNull();
    store.remember('g2', 'c2', 'b', 50);
    store.clearGroup('g2');
    expect(store.get('g2', 'c2', 50)).toBeNull();
  });
});
