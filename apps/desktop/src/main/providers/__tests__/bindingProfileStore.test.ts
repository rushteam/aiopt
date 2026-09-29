import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDING_PROFILE_NAME } from '../../../shared/bindingProfiles';
import { createBindingProfileStore } from '../bindingProfileStore';

describe('bindingProfileStore', () => {
  it('upserts bindings when the profile name already exists', () => {
    let saved: unknown = { profiles: [] };
    const store = createBindingProfileStore({
      load: () => saved,
      save: (doc) => {
        saved = doc;
      },
    });
    const bindings = { claude: { providerId: 'p1', modelId: 'm1' } };
    const first = store.saveFromBindings(DEFAULT_BINDING_PROFILE_NAME, bindings);
    const second = store.saveFromBindings(DEFAULT_BINDING_PROFILE_NAME, {
      codex: { providerId: 'p2', modelId: 'm2' },
    });
    expect(first.id).toBe(second.id);
    expect(store.list()).toHaveLength(1);
    expect(store.get(first.id)?.bindings.codex?.providerId).toBe('p2');
  });
});
