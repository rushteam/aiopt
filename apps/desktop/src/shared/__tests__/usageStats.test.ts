import { describe, expect, it } from 'vitest';
import { aggregateUsage, dayKey, USAGE_RETENTION_DAYS, type UsageEvent } from '../usageStats';

const DAY = 24 * 60 * 60 * 1000;

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    ts: Date.parse('2026-09-01T12:00:00Z'),
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
    ...overrides,
  };
}

describe('dayKey', () => {
  it('buckets by UTC calendar day', () => {
    expect(dayKey(Date.parse('2026-09-01T00:00:00Z'))).toBe('2026-09-01');
    expect(dayKey(Date.parse('2026-09-01T23:59:59Z'))).toBe('2026-09-01');
    // 30 min past midnight UTC is still the new day regardless of any local offset.
    expect(dayKey(Date.parse('2026-09-02T00:30:00Z'))).toBe('2026-09-02');
  });
});

describe('aggregateUsage — totals', () => {
  it('sums requests, ok/error, and tokens', () => {
    const snap = aggregateUsage([
      event({ inputTokens: 10, outputTokens: 20 }),
      event({ ok: false, status: 502, inputTokens: 0, outputTokens: 0 }),
      event({ inputTokens: 5, outputTokens: 5 }),
    ]);
    expect(snap.totals).toEqual({
      requests: 3,
      okRequests: 2,
      errorRequests: 1,
      inputTokens: 15,
      outputTokens: 25,
      totalTokens: 40,
    });
    expect(snap.eventCount).toBe(3);
  });

  it('returns zeroed totals and empty groups for no events', () => {
    const snap = aggregateUsage([]);
    expect(snap.totals.requests).toBe(0);
    expect(snap.totals.totalTokens).toBe(0);
    expect(snap.byProvider).toEqual([]);
    expect(snap.byAgent).toEqual([]);
    expect(snap.byModel).toEqual([]);
    expect(snap.daily).toEqual([]);
    expect(snap.eventCount).toBe(0);
  });
});

describe('aggregateUsage — grouping', () => {
  it('groups by provider, agent, and model, sorted by total tokens desc', () => {
    const snap = aggregateUsage([
      event({ providerId: 'pA', agentId: 'codex', model: 'm1', inputTokens: 1, outputTokens: 1 }),
      event({ providerId: 'pB', agentId: 'claude', model: 'm2', inputTokens: 100, outputTokens: 100 }),
      event({ providerId: 'pA', agentId: 'codex', model: 'm1', inputTokens: 2, outputTokens: 2 }),
    ]);
    expect(snap.byProvider.map((b) => b.key)).toEqual(['pB', 'pA']); // pB has more tokens
    expect(snap.byProvider.find((b) => b.key === 'pA')).toMatchObject({ requests: 2, totalTokens: 6 });
    expect(snap.byAgent.map((b) => b.key)).toEqual(['claude', 'codex']);
    expect(snap.byModel.map((b) => b.key)).toEqual(['m2', 'm1']);
  });
});

describe('aggregateUsage — daily series', () => {
  it('buckets events into ascending UTC days', () => {
    const snap = aggregateUsage([
      event({ ts: Date.parse('2026-09-02T01:00:00Z'), inputTokens: 1, outputTokens: 1 }),
      event({ ts: Date.parse('2026-09-01T10:00:00Z'), inputTokens: 2, outputTokens: 2 }),
      event({ ts: Date.parse('2026-09-01T20:00:00Z'), inputTokens: 3, outputTokens: 3 }),
    ]);
    expect(snap.daily.map((d) => d.day)).toEqual(['2026-09-01', '2026-09-02']);
    expect(snap.daily[0]).toMatchObject({ day: '2026-09-01', requests: 2, totalTokens: 10 });
    expect(snap.daily[1]).toMatchObject({ day: '2026-09-02', requests: 1, totalTokens: 2 });
  });
});

describe('aggregateUsage — retention window', () => {
  it('drops events older than retentionDays before now', () => {
    const now = Date.parse('2026-09-30T00:00:00Z');
    const snap = aggregateUsage(
      [
        event({ ts: now - 5 * DAY }), // in window
        event({ ts: now - 100 * DAY }), // older than 90d → dropped
      ],
      { now, retentionDays: USAGE_RETENTION_DAYS },
    );
    expect(snap.eventCount).toBe(1);
    expect(snap.totals.requests).toBe(1);
  });

  it('keeps everything when now is not provided (no cutoff)', () => {
    const snap = aggregateUsage([event({ ts: 1 }), event({ ts: 2 })]);
    expect(snap.eventCount).toBe(2);
    expect(snap.since).toBe(1);
    expect(snap.until).toBe(2);
  });

  it('drops events with a non-finite timestamp without crashing', () => {
    const snap = aggregateUsage([event(), { ...event(), ts: NaN }, { ...event(), ts: Infinity }]);
    expect(snap.eventCount).toBe(1);
    expect(snap.daily).toHaveLength(1);
  });
});
