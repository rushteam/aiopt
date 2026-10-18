import { describe, expect, it } from 'vitest';
import { createRoutingGroupStore, type RoutingGroupsDocument } from '../routingGroupStore';

describe('routingGroupStore', () => {
  it('persists add/replace/remove and summaries', () => {
    let saved: RoutingGroupsDocument | undefined;
    const store = createRoutingGroupStore({
      load: () => ({}),
      save: (doc) => {
        saved = doc;
      },
    });

    const g = store.add({
      name: 'primary',
      members: [
        { providerId: 'p1', modelId: 'm1' },
        { providerId: 'p1', modelId: 'm1' }, // de-duped
        { providerId: 'p2', modelId: 'm2' },
      ],
      strategy: 'rotate',
      affinity: 'session',
    });
    expect(g.members).toHaveLength(2);
    expect(saved?.groups).toHaveLength(1);
    expect(store.summaries()[0]?.virtualProviderId).toContain(g.id);

    store.replace(g.id, {
      name: 'renamed',
      members: [{ providerId: 'p2', modelId: 'm2' }],
      strategy: 'least_used',
      affinity: 'off',
    });
    expect(store.get(g.id)?.name).toBe('renamed');
    expect(store.get(g.id)?.strategy).toBe('least_used');

    store.remove(g.id);
    expect(store.list()).toHaveLength(0);
    expect(saved?.groups).toHaveLength(0);
  });

  it('loads fail-closed (drops invalid groups)', () => {
    const store = createRoutingGroupStore({
      load: () => ({
        groups: [
          { id: 'ok', name: 'ok', members: [{ providerId: 'p', modelId: 'm' }], createdAt: 1 },
          { id: 'bad', name: '', members: [] },
          null,
        ],
      }),
      save: () => {},
    });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.id).toBe('ok');
  });
});
