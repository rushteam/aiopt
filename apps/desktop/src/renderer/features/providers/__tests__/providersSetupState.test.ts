import { describe, expect, it } from 'vitest';
import { shouldShowProvidersSetupGuide } from '../providersSetupState';

describe('shouldShowProvidersSetupGuide', () => {
  it('shows when the provider pool is empty (nothing configured yet)', () => {
    expect(shouldShowProvidersSetupGuide({ poolEmpty: true })).toBe(true);
  });

  it('hides once at least one real provider exists in the pool', () => {
    expect(shouldShowProvidersSetupGuide({ poolEmpty: false })).toBe(false);
  });
});
