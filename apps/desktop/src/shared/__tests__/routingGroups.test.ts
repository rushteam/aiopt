import { describe, expect, it } from 'vitest';
import {
  extractConversationKey,
  isRoutingGroupProviderId,
  ROUTING_GROUP_MODEL_ID,
  routingGroupVirtualId,
  shouldFailoverStatus,
} from '../routingGroups';

describe('routing group ids', () => {
  it('builds and detects virtual provider ids', () => {
    const id = routingGroupVirtualId('abc');
    expect(isRoutingGroupProviderId(id)).toBe(true);
    expect(isRoutingGroupProviderId('real-uuid')).toBe(false);
    expect(ROUTING_GROUP_MODEL_ID).toBe('__route__');
  });
});

describe('shouldFailoverStatus', () => {
  it('failover on transport / overload / gateway errors only', () => {
    expect(shouldFailoverStatus(0)).toBe(true);
    expect(shouldFailoverStatus(429)).toBe(true);
    expect(shouldFailoverStatus(529)).toBe(true);
    expect(shouldFailoverStatus(503)).toBe(true);
    expect(shouldFailoverStatus(401)).toBe(true);
    expect(shouldFailoverStatus(400)).toBe(false);
    expect(shouldFailoverStatus(200)).toBe(false);
  });
});

describe('extractConversationKey', () => {
  const headers = (h: Record<string, string>) => ({
    get: (name: string) => {
      const want = name.toLowerCase();
      for (const [k, v] of Object.entries(h)) {
        if (k.toLowerCase() === want) return v;
      }
      return null;
    },
  });

  it('prefers session_id header', () => {
    expect(extractConversationKey(headers({ session_id: 's-1' }), {})).toBe('s-1');
  });

  it('reads nested metadata.user_id JSON', () => {
    expect(
      extractConversationKey(headers({}), {
        metadata: { user_id: JSON.stringify({ session_id: 'nested' }) },
      }),
    ).toBe('nested');
  });

  it('falls back to prompt_cache_key', () => {
    expect(extractConversationKey(headers({}), { prompt_cache_key: 'pck-9' })).toBe('pck:pck-9');
  });

  it('rejects empty / oversized / control chars', () => {
    expect(extractConversationKey(headers({ session_id: '  ' }), {})).toBeNull();
    expect(extractConversationKey(headers({ session_id: 'a\nb' }), {})).toBeNull();
    expect(extractConversationKey(headers({ session_id: 'x'.repeat(200) }), {})).toBeNull();
  });
});
