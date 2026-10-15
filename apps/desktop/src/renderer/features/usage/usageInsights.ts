// Pure derivations for the Usage screen — no React, no I/O, so they are unit-testable.
//
// Both usage sources (proxy events, agent session logs) hand the renderer a SPARSE daily
// series: only days with traffic appear. Averages and the chart need a DENSE series (a quiet
// day is a real zero, not a missing point), so everything here starts from `fillDays`.
//
// Day keys are LOCAL 'YYYY-MM-DD' (system time zone), built by the shared `dayKey` — both
// sources bucket with it, so these helpers must use it too or a day would land in the wrong slot.

import { dayKey, dayKeyToDate, shiftDayKey } from '../../../shared/usageStats';

/** `n` consecutive local day keys, ascending, ending with the day that contains `endTs`. */
export function dayRange(endTs: number, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftDayKey(endTs, -i));
  return out;
}

/** Day of week (0 = Sunday) of a local day key. */
export function weekdayOf(day: string): number {
  return dayKeyToDate(day).getDay();
}

export { dayKey, dayKeyToDate };

/** One sparse input point: per-segment token counts plus a request/response count. */
export interface DayInput {
  day: string;
  segments: readonly number[];
  count: number;
}

/** One dense series point. `total` is the sum of `segments`. */
export interface FilledDay {
  day: string;
  segments: number[];
  total: number;
  count: number;
}

/** Project a sparse series onto `days`, zero-filling the gaps. Points outside `days` drop. */
export function fillDays(points: readonly DayInput[], days: readonly string[], segmentCount: number): FilledDay[] {
  const byDay = new Map<string, DayInput>();
  for (const p of points) byDay.set(p.day, p);
  return days.map((day) => {
    const p = byDay.get(day);
    const segments = Array.from({ length: segmentCount }, (_, i) => Math.max(0, p?.segments[i] ?? 0));
    return { day, segments, total: segments.reduce((a, b) => a + b, 0), count: p?.count ?? 0 };
  });
}

/** Index of the first day carrying any usage, or -1 when the whole series is empty. */
function firstActiveIndex(series: readonly FilledDay[]): number {
  return series.findIndex((d) => d.total > 0 || d.count > 0);
}

export interface UsageAverages {
  /** Days from the first active day through today (inclusive); 0 when there is no data. */
  spanDays: number;
  today: number;
  /** Mean tokens per day over the whole span. */
  dailyAvg: number;
  /** Mean tokens per day over the last 7 / 30 days (fewer if the span is shorter). */
  avg7: number;
  avg30: number;
  /** Relative change vs. the previous window; null when history doesn't cover it. */
  change7: number | null;
  change30: number | null;
  /** Today vs. the span's daily average; null when there is no average to compare. */
  todayVsAvg: number | null;
  /** The span's daily average scaled to a 30-day month. */
  monthlyAvg: number;
  peak: { day: string; total: number } | null;
  activeDays: number;
  totalTokens: number;
  totalCount: number;
}

/** Relative change `cur` vs `prev`; null when `prev` is zero (no meaningful baseline). */
export function relativeChange(cur: number, prev: number): number | null {
  return prev > 0 ? (cur - prev) / prev : null;
}

function sum(series: readonly FilledDay[]): number {
  return series.reduce((a, d) => a + d.total, 0);
}

/**
 * Averages over a dense series that ENDS TODAY. A window longer than the data's span is
 * averaged over the span instead, so a user three days in doesn't see their 7-day average
 * diluted by four days that predate them.
 */
export function computeAverages(series: readonly FilledDay[]): UsageAverages {
  const len = series.length;
  const first = firstActiveIndex(series);
  const spanDays = first < 0 ? 0 : len - first;
  const active = first < 0 ? [] : series.slice(first);
  const totalTokens = sum(active);
  const totalCount = active.reduce((a, d) => a + d.count, 0);

  const windowAvg = (n: number): number => {
    const days = Math.min(n, spanDays);
    return days > 0 ? sum(series.slice(len - days)) / days : 0;
  };
  const prevAvg = (n: number): number | null =>
    spanDays >= 2 * n ? sum(series.slice(len - 2 * n, len - n)) / n : null;

  const dailyAvg = spanDays > 0 ? totalTokens / spanDays : 0;
  const avg7 = windowAvg(7);
  const avg30 = windowAvg(30);
  const prev7 = prevAvg(7);
  const prev30 = prevAvg(30);
  const today = series[len - 1]?.total ?? 0;

  let peak: UsageAverages['peak'] = null;
  for (const d of active) if (d.total > 0 && (!peak || d.total > peak.total)) peak = { day: d.day, total: d.total };

  return {
    spanDays,
    today,
    dailyAvg,
    avg7,
    avg30,
    change7: prev7 === null ? null : relativeChange(avg7, prev7),
    change30: prev30 === null ? null : relativeChange(avg30, prev30),
    todayVsAvg: relativeChange(today, dailyAvg),
    monthlyAvg: dailyAvg * 30,
    peak,
    activeDays: active.filter((d) => d.total > 0).length,
    totalTokens,
    totalCount,
  };
}

/**
 * Trailing moving average of `total` over `window` days. Days before the first active day are
 * null (nothing to average yet); the first few active days average over what exists so the
 * line starts with the data instead of ramping up from zero.
 */
export function trailingAverage(series: readonly FilledDay[], window: number): (number | null)[] {
  const first = firstActiveIndex(series);
  return series.map((_, i) => {
    if (first < 0 || i < first) return null;
    const from = Math.max(first, i - window + 1);
    return sum(series.slice(from, i + 1)) / (i - from + 1);
  });
}

/** Mean tokens per day over the trailing `range` days of a series ending today. */
export function rangeAverage(series: readonly FilledDay[], range: number): number {
  const first = firstActiveIndex(series);
  if (first < 0) return 0;
  const days = Math.min(range, series.length - first);
  return days > 0 ? sum(series.slice(series.length - days)) / days : 0;
}

/** A "nice" axis ceiling ≥ v: 1, 2, 2.5 or 5 times a power of ten. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}
