import { describe, expect, it } from 'vitest';
import {
  COMBINED_PROVIDER_ID,
  decodeCombinedModelKey,
  encodeCombinedModelKey,
  formatModelRef,
  providerSlug,
} from '../modelRef';

describe('modelRef', () => {
  it('formats provider/model refs from display names', () => {
    expect(formatModelRef('DeepSeek', { id: 'deepseek-chat' })).toBe('deepseek/deepseek-chat');
    expect(formatModelRef('My Relay', { id: 'gpt-4', alias: 'fast' })).toBe('my-relay/fast');
  });

  it('slugifies provider names', () => {
    expect(providerSlug('  OpenRouter  ')).toBe('openrouter');
  });

  it('round-trips combined model keys', () => {
    const key = encodeCombinedModelKey('p1', 'm/id');
    expect(decodeCombinedModelKey(key)).toEqual({ providerId: 'p1', modelId: 'm/id' });
    expect(COMBINED_PROVIDER_ID).not.toContain('\u241f');
  });
});
