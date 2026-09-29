import { describe, expect, it } from 'vitest';
import { AGENT_SPECS, BINDABLE_AGENT_IDS } from '../../../../shared/aiProviders';
import { BINDABLE_ADAPTER_FACTORIES, createAdapterRegistry } from '../registry';

describe('BINDABLE_ADAPTER_FACTORIES', () => {
  it('lists exactly one factory per bindable agent in AGENT_SPECS', () => {
    expect(Object.keys(BINDABLE_ADAPTER_FACTORIES).sort()).toEqual(
      [...BINDABLE_AGENT_IDS].sort(),
    );
  });

  it('builds a registry whose adapter ids match AGENT_SPECS names', () => {
    const reg = createAdapterRegistry();
    for (const id of BINDABLE_AGENT_IDS) {
      const adapter = reg.get(id);
      expect(adapter, `missing adapter for ${id}`).toBeDefined();
      expect(adapter!.def.name).toBe(AGENT_SPECS[id].name);
      expect(adapter!.def.id).toBe(id);
    }
  });
});
