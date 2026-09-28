import { describe, expect, it } from 'vitest';
import { buildCombinedProviderSummary } from '../combinedProvider';
import { COMBINED_PROVIDER_ID } from '../modelRef';
import type { ProviderSummary } from '../ipc-channels';

const base: ProviderSummary = {
  id: 'a',
  name: 'Alpha',
  apiFormats: ['openai'],
  baseUrl: 'https://a/v1',
  models: [{ id: 'm1' }],
  createdAt: 1,
  hasKey: true,
};

describe('buildCombinedProviderSummary', () => {
  it('returns null for an empty pool', () => {
    expect(buildCombinedProviderSummary([], 'All')).toBeNull();
  });

  it('aggregates models with encoded ids', () => {
    const combined = buildCombinedProviderSummary([base], 'All');
    expect(combined?.id).toBe(COMBINED_PROVIDER_ID);
    expect(combined?.models[0]?.alias).toBe('alpha/m1');
    expect(combined?.virtual).toBe(true);
  });
});
