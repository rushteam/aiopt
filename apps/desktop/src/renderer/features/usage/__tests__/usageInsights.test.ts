import { describe, expect, it } from 'vitest';
import {
  computeAverages,
  dayRange,
  fillDays,
  niceCeil,
  rangeAverage,
  relativeChange,
  trailingAverage,
  weekdayOf,
  type DayInput,
} from '../usageInsights';

const NOW = new Date(2025, 0, 31, 15, 30).getTime(); // 2025-01-31, local time (day keys are local)

/** A dense series of `n` days ending at NOW, with `totals[i]` on day i (single segment). */
function series(totals: number[]) {
  const days = dayRange(NOW, totals.length);
  const points: DayInput[] = days.map((day, i) => {
    const v = totals[i] ?? 0;
    return { day, segments: [v], count: v > 0 ? 1 : 0 };
  });
  return fillDays(points, days, 1);
}

describe('dayRange', () => {
  it('ends on the local day containing the timestamp, ascending, crossing month bounds', () => {
    expect(dayRange(NOW, 3)).toEqual(['2025-01-29', '2025-01-30', '2025-01-31']);
    expect(dayRange(new Date(2025, 2, 1, 0, 0, 1).getTime(), 2)).toEqual(['2025-02-28', '2025-03-01']);
  });

  it('reads the weekday of a local day key', () => {
    expect(weekdayOf('2025-01-31')).toBe(5); // a Friday
    expect(weekdayOf('2025-02-02')).toBe(0);
  });
});

describe('fillDays', () => {
  it('zero-fills missing days, sums segments, and drops points outside the range', () => {
    const days = ['2025-01-30', '2025-01-31'];
    const out = fillDays(
      [
        { day: '2025-01-31', segments: [3, 4], count: 2 },
        { day: '2024-12-01', segments: [99, 99], count: 9 },
      ],
      days,
      2,
    );
    expect(out).toEqual([
      { day: '2025-01-30', segments: [0, 0], total: 0, count: 0 },
      { day: '2025-01-31', segments: [3, 4], total: 7, count: 2 },
    ]);
  });
});

describe('computeAverages', () => {
  it('is all zeros / nulls for an empty series', () => {
    const a = computeAverages(series([0, 0, 0]));
    expect(a.spanDays).toBe(0);
    expect(a.dailyAvg).toBe(0);
    expect(a.avg7).toBe(0);
    expect(a.peak).toBeNull();
    expect(a.todayVsAvg).toBeNull();
    expect(a.change7).toBeNull();
  });

  it('averages over the span since the first active day, not the whole window', () => {
    // 10 empty days, then 3 days of data ending today.
    const a = computeAverages(series([...Array(10).fill(0), 30, 0, 60]));
    expect(a.spanDays).toBe(3);
    expect(a.dailyAvg).toBe(30);
    expect(a.avg7).toBe(30); // window longer than span → averaged over the span
    expect(a.today).toBe(60);
    expect(a.todayVsAvg).toBe(1); // +100%
    expect(a.activeDays).toBe(2);
    expect(a.peak).toEqual({ day: '2025-01-31', total: 60 });
    expect(a.monthlyAvg).toBe(900);
    expect(a.change7).toBeNull(); // not 14 days of history
  });

  it('compares the last 7 days against the 7 before when history covers both', () => {
    const a = computeAverages(series([...Array(7).fill(10), ...Array(7).fill(15)]));
    expect(a.avg7).toBe(15);
    expect(a.change7).toBeCloseTo(0.5);
    expect(a.change30).toBeNull();
  });
});

describe('trailingAverage', () => {
  it('is null before data starts and averages only existing days at the start', () => {
    expect(trailingAverage(series([0, 10, 20, 30, 40]), 3)).toEqual([null, 10, 15, 20, 30]);
  });
});

describe('rangeAverage', () => {
  it('averages the trailing range, clamped to the span', () => {
    const s = series([0, 0, 10, 20, 30]);
    expect(rangeAverage(s, 2)).toBe(25);
    expect(rangeAverage(s, 30)).toBe(20);
    expect(rangeAverage(series([0, 0]), 7)).toBe(0);
  });
});

describe('helpers', () => {
  it('relativeChange has no baseline at zero', () => {
    expect(relativeChange(5, 0)).toBeNull();
    expect(relativeChange(5, 10)).toBe(-0.5);
  });

  it('niceCeil rounds up to 1/2/2.5/5 × 10^n', () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(1_800)).toBe(2_000);
    expect(niceCeil(2_100)).toBe(2_500);
    expect(niceCeil(4_200_000)).toBe(5_000_000);
  });
});
