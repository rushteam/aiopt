// Usage statistics — pure types + pure aggregation, shared by main and renderer.
//
// The translation proxy is the only choke point AiOpt sits on: every CROSS-FORMAT
// binding routes through it, so at each completion it already holds the upstream
// `usage` (token counts) and the full RouteSpec. This module defines the event it
// records and the pure function that folds a flat event log into a snapshot.
//
// PRIVACY (see docs/dev-rules/credentials-and-local-storage.md): a UsageEvent carries
// ONLY counts + identifiers (providerId UUID, agentId, the wire model name) + status
// + timestamp. Never content, never keys, never token PLAINTEXT — same disclosure
// surface as the proxy's existing "may log token counts" rule, nothing new.
//
// No I/O, no Electron. `dayKey` buckets by UTC so tests can assert deterministically.

import type { ApiFormat } from './aiProviders';

/** How long recorded events are retained; older events are pruned on load and aggregation. */
export const USAGE_RETENTION_DAYS = 90;

/**
 * One recorded upstream attempt. `ts` is stamped by the store at record time (the proxy
 * passes only the semantic fields — see `UsageEventInput`). Contains no content/keys/tokens
 * beyond aggregate counts.
 */
export interface UsageEvent {
  /** Epoch milliseconds, stamped by the store on record. */
  ts: number;
  agentId: string;
  /** Provider UUID (stable); the display name is resolved by the renderer, never frozen here. */
  providerId: string;
  /** The wire model name sent upstream. */
  model: string;
  inboundFormat: ApiFormat;
  outboundFormat: ApiFormat;
  /** True when the client asked for a streamed response. */
  streamed: boolean;
  /** True when the upstream attempt succeeded (2xx and readable). */
  ok: boolean;
  /** Upstream HTTP status (0 when the request never reached the provider). */
  status: number;
  inputTokens: number;
  outputTokens: number;
}

/** The proxy-supplied shape: everything but the store-stamped `ts`. */
export type UsageEventInput = Omit<UsageEvent, 'ts'>;

/** Additive counters shared by totals and every grouped bucket. */
export interface UsageTotals {
  requests: number;
  okRequests: number;
  errorRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** A grouped roll-up; `key` is a providerId / agentId / model (label resolved in the UI). */
export interface UsageBucket extends UsageTotals {
  key: string;
}

/** One calendar day (UTC) of totals for the time series. */
export interface UsageDailyPoint extends UsageTotals {
  /** 'YYYY-MM-DD' in UTC. */
  day: string;
}

/** The aggregated view handed to the renderer. */
export interface UsageSnapshot {
  totals: UsageTotals;
  byProvider: UsageBucket[];
  byAgent: UsageBucket[];
  byModel: UsageBucket[];
  daily: UsageDailyPoint[];
  /** Window bounds actually covered (epoch ms); equal when empty. */
  since: number;
  until: number;
  retentionDays: number;
  eventCount: number;
}

export interface AggregateOptions {
  /** Retention window in days; events older than this before `now` are excluded. */
  retentionDays?: number;
  /** "Now" as epoch ms; injected so aggregation stays pure/testable. */
  now?: number;
}

/** UTC day bucket key ('YYYY-MM-DD') for an epoch-ms timestamp. */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function emptyTotals(): UsageTotals {
  return { requests: 0, okRequests: 0, errorRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addEvent(t: UsageTotals, e: UsageEvent): void {
  t.requests += 1;
  if (e.ok) t.okRequests += 1;
  else t.errorRequests += 1;
  t.inputTokens += e.inputTokens;
  t.outputTokens += e.outputTokens;
  t.totalTokens += e.inputTokens + e.outputTokens;
}

function bucketList(map: Map<string, UsageTotals>): UsageBucket[] {
  return [...map.entries()]
    .map(([key, t]) => ({ key, ...t }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests || a.key.localeCompare(b.key));
}

function into(map: Map<string, UsageTotals>, key: string, e: UsageEvent): void {
  let t = map.get(key);
  if (!t) {
    t = emptyTotals();
    map.set(key, t);
  }
  addEvent(t, e);
}

/**
 * Fold a flat event log into a snapshot: drop events outside the retention window, then
 * accumulate totals + group by provider/agent/model + build the daily (UTC) series.
 * Pure — no I/O, deterministic given `opts.now`.
 */
export function aggregateUsage(events: readonly UsageEvent[], opts: AggregateOptions = {}): UsageSnapshot {
  const retentionDays = opts.retentionDays ?? USAGE_RETENTION_DAYS;
  const now = opts.now ?? 0;
  const cutoff = now > 0 ? now - retentionDays * 24 * 60 * 60 * 1000 : Number.NEGATIVE_INFINITY;

  const totals = emptyTotals();
  const byProvider = new Map<string, UsageTotals>();
  const byAgent = new Map<string, UsageTotals>();
  const byModel = new Map<string, UsageTotals>();
  const byDay = new Map<string, UsageTotals>();

  let since = 0;
  let until = 0;
  let count = 0;

  for (const e of events) {
    // Guard NaN/Infinity explicitly: NaN is `typeof 'number'` and every NaN comparison is
    // false, so it would otherwise slip past `< cutoff` and crash dayKey(new Date(NaN)).
    if (!Number.isFinite(e.ts) || e.ts < cutoff) continue;
    if (count === 0) {
      since = e.ts;
      until = e.ts;
    } else {
      if (e.ts < since) since = e.ts;
      if (e.ts > until) until = e.ts;
    }
    count += 1;
    addEvent(totals, e);
    into(byProvider, e.providerId, e);
    into(byAgent, e.agentId, e);
    into(byModel, e.model, e);
    into(byDay, dayKey(e.ts), e);
  }

  const daily: UsageDailyPoint[] = [...byDay.entries()]
    .map(([day, t]) => ({ day, ...t }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    totals,
    byProvider: bucketList(byProvider),
    byAgent: bucketList(byAgent),
    byModel: bucketList(byModel),
    daily,
    since,
    until,
    retentionDays,
    eventCount: count,
  };
}
