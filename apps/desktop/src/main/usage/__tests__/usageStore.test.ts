import { describe, expect, it, vi } from 'vitest';
import { createUsageStore, type UsagePersistence } from '../usageStore';
import type { UsageEvent, UsageEventInput } from '../../../shared/usageStats';

const DAY = 24 * 60 * 60 * 1000;

/** In-memory persistence so the store logic tests without a filesystem. */
function memoryPersistence(seed: unknown[] = []): UsagePersistence & {
  readonly all: UsageEvent[];
  readonly rewrites: number;
} {
  let lines: unknown[] = [...seed];
  let rewrites = 0;
  return {
    load: () => lines,
    append: (event) => {
      lines.push(event);
    },
    rewrite: (events) => {
      lines = [...events];
      rewrites += 1;
    },
    get all() {
      return lines.filter((l): l is UsageEvent => !!l && typeof l === 'object') as UsageEvent[];
    },
    get rewrites() {
      return rewrites;
    },
  };
}

function input(overrides: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    agentId: 'codex',
    providerId: 'p1',
    model: 'deepseek-chat',
    inboundFormat: 'openai-responses',
    outboundFormat: 'openai',
    streamed: false,
    ok: true,
    status: 200,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...overrides,
  };
}

describe('usage store — record + snapshot', () => {
  it('stamps ts, appends, and reflects the event in the snapshot', () => {
    const now = Date.parse('2026-09-01T00:00:00Z');
    const p = memoryPersistence();
    const store = createUsageStore(p, { now: () => now });
    store.record(input({ inputTokens: 5, outputTokens: 7 }));
    const snap = store.snapshot();
    expect(snap.totals).toMatchObject({ requests: 1, okRequests: 1, inputTokens: 5, outputTokens: 7, totalTokens: 12 });
    expect(p.all[0]?.ts).toBe(now);
  });

  it('loads an event recorded before cache/reasoning were tracked, reading them as 0', () => {
    const now = Date.parse('2026-09-01T00:00:00Z');
    const legacy = { ...input({ inputTokens: 3, outputTokens: 4 }), ts: now - 1000 } as Record<string, unknown>;
    delete legacy.cacheReadTokens;
    delete legacy.cacheWriteTokens;
    delete legacy.reasoningTokens;
    const store = createUsageStore(memoryPersistence([legacy]), { now: () => now });
    expect(store.snapshot().totals).toMatchObject({
      requests: 1,
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 7,
    });
  });

  it('records cache and reasoning counts', () => {
    const store = createUsageStore(memoryPersistence(), { now: () => 1000 });
    store.record(input({ inputTokens: 5, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 10, reasoningTokens: 2 }));
    expect(store.snapshot().totals).toMatchObject({ cacheReadTokens: 100, cacheWriteTokens: 10, reasoningTokens: 2, totalTokens: 122 });
  });

  it('clear empties the store and rewrites the log', () => {
    const p = memoryPersistence();
    const store = createUsageStore(p, { now: () => 1000 });
    store.record(input());
    store.clear();
    expect(store.snapshot().totals.requests).toBe(0);
    expect(p.all).toEqual([]);
  });
});

describe('usage store — load pruning (fail-closed)', () => {
  it('drops expired and corrupt lines on load and compacts the file', () => {
    const now = Date.parse('2026-09-30T00:00:00Z');
    const fresh: UsageEvent = { ...input(), ts: now - 5 * DAY };
    const expired: UsageEvent = { ...input(), ts: now - 100 * DAY };
    const p = memoryPersistence([
      fresh,
      expired,
      { garbage: true }, // wrong shape → dropped
      { ...input(), ts: 'nope' }, // bad ts → dropped
    ]);
    const store = createUsageStore(p, { now: () => now, retentionDays: 90 });
    expect(store.snapshot().eventCount).toBe(1);
    // Something was dropped → the log was compacted down to the single valid line.
    expect(p.rewrites).toBe(1);
    expect(p.all).toHaveLength(1);
    expect(p.all[0]?.ts).toBe(fresh.ts);
  });

  it('does not rewrite when every persisted line is valid and in-window', () => {
    const now = Date.parse('2026-09-30T00:00:00Z');
    const p = memoryPersistence([{ ...input(), ts: now - DAY }]);
    createUsageStore(p, { now: () => now });
    expect(p.rewrites).toBe(0);
  });
});

describe('usage store — onChange', () => {
  it('notifies subscribers on record and clear, and stops after unsubscribe', () => {
    const p = memoryPersistence();
    const store = createUsageStore(p, { now: () => 1 });
    const listener = vi.fn();
    const off = store.onChange(listener);
    store.record(input());
    store.clear();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    store.record(input());
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
