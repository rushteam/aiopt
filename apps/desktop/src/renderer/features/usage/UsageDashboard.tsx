// Usage dashboard — the shared visual layer for both usage sources (proxy / agent logs).
//
// A source adapts its snapshot into `DashboardData` (a sparse daily series split into token
// segments, plus source-specific summary stats); everything here is presentation over the
// pure derivations in ./usageInsights. Answers the questions a user actually asks of usage:
//   · How much today, and is that more or less than usual?        → KPI cards
//   · What's my daily / 7-day / monthly average, and its trend?     → KPI cards + deltas
//   · How does each day compare to the average?                     → chart avg + moving-avg line
//   · Where do the tokens go (input/output/cache), which weekdays?  → mix bar, weekday panel
//
// All colors are semantic tokens (chart series included), so both modes come for free.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { elevation, fontSize, radius, space, token, type TokenName } from '../../themes/tokens';
import { useI18n, type TranslateFn } from '../../i18n';
import { segmentButtonChrome, segmentedRootStyle } from '../../components/ui/controlStyles';
import {
  computeAverages,
  dayKey,
  dayKeyToDate,
  dayRange,
  fillDays,
  niceCeil,
  rangeAverage,
  trailingAverage,
  weekdayOf,
  type DayInput,
  type FilledDay,
} from './usageInsights';

export interface DashboardSegment {
  label: string;
  color: TokenName;
}

export interface DashboardStat {
  label: string;
  value: string;
  hint?: string;
}

export interface DashboardData {
  /** Sparse daily series; `segments` aligns with `segments` below. */
  daily: readonly DayInput[];
  segments: readonly DashboardSegment[];
  retentionDays: number;
  /** Label for `DayInput.count` (Requests / Responses). */
  countLabel: string;
  /** Source-specific facts shown in the summary panel (success rate, cache hit…). */
  stats: readonly DashboardStat[];
}

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];
const TREND_WINDOW = 7;

// ─── Formatting ─────────────────────────────────────────────────────────────

function useFormatters() {
  const { locale } = useI18n();
  return useMemo(() => {
    const full = new Intl.NumberFormat(locale);
    const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
    const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
    const signedPct = new Intl.NumberFormat(locale, {
      style: 'percent',
      maximumFractionDigits: 0,
      signDisplay: 'exceptZero',
    });
    // Day keys are local calendar days, so they are formatted in the system zone too.
    const date = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', weekday: 'short' });
    const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    return {
      full: (n: number) => full.format(Math.round(n)),
      compact: (n: number) => compact.format(Math.round(n)),
      pct: (r: number) => pct.format(r),
      signedPct: (r: number) => signedPct.format(r),
      date: (day: string) => date.format(dayKeyToDate(day)),
      weekday: (wd: number) => weekday.format(new Date(2024, 0, 7 + wd)), // 2024-01-07 is a Sunday
    };
  }, [locale]);
}

type Formatters = ReturnType<typeof useFormatters>;

function fill(key: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((s, [k, v]) => s.replace(`{{${k}}}`, v), key);
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

export function UsageDashboard({ data, t }: { data: DashboardData; t: TranslateFn }) {
  const f = useFormatters();
  const [range, setRange] = useState<Range>(30);

  // A dense series over the whole retention window, ending today (local day, like the keys).
  // Keyed on the date string so it recomputes after midnight on the next render. A data day
  // later than the local clock (clock skew) extends the window rather than vanishing.
  const clockDay = dayKey(Date.now());
  const latest = data.daily.reduce((m, d) => (d.day > m ? d.day : m), '');
  const today = latest > clockDay ? latest : clockDay;
  const series = useMemo(
    () =>
      fillDays(data.daily, dayRange(dayKeyToDate(today).getTime(), Math.max(data.retentionDays, 1)), data.segments.length),
    [data.daily, data.retentionDays, data.segments.length, today],
  );
  const avg = useMemo(() => computeAverages(series), [series]);

  return (
    <>
      <section style={sectionStyle}>
        <div style={kpiGridStyle}>
          <KpiCard
            label={t('usage.kpi.today')}
            value={f.compact(avg.today)}
            title={f.full(avg.today)}
            delta={avg.todayVsAvg}
            deltaText={avg.todayVsAvg === null ? t('usage.kpi.noToday') : fill(t('usage.kpi.vsDailyAvg'), { pct: f.signedPct(avg.todayVsAvg) })}
            spark={series.slice(-14)}
          />
          <KpiCard
            label={t('usage.kpi.dailyAvg')}
            value={f.compact(avg.dailyAvg)}
            title={f.full(avg.dailyAvg)}
            unit={t('usage.kpi.perDay')}
            deltaText={fill(t('usage.kpi.activeDays'), { active: String(avg.activeDays), span: String(avg.spanDays) })}
          />
          <KpiCard
            label={t('usage.kpi.avg7')}
            value={f.compact(avg.avg7)}
            title={f.full(avg.avg7)}
            unit={t('usage.kpi.perDay')}
            delta={avg.change7}
            deltaText={avg.change7 === null ? t('usage.kpi.noCompare') : fill(t('usage.kpi.vsPrev7'), { pct: f.signedPct(avg.change7) })}
          />
          <KpiCard
            label={t('usage.kpi.monthlyAvg')}
            value={f.compact(avg.monthlyAvg)}
            title={f.full(avg.monthlyAvg)}
            unit={t('usage.kpi.perMonth')}
            delta={avg.change30}
            deltaText={
              avg.change30 === null
                ? fill(t('usage.kpi.avg30'), { value: f.compact(avg.avg30) })
                : fill(t('usage.kpi.vsPrev30'), { pct: f.signedPct(avg.change30) })
            }
          />
        </div>
      </section>

      <section style={sectionStyle}>
        <Panel
          title={t('usage.chart.title')}
          actions={<RangeSwitch value={range} onChange={setRange} max={data.retentionDays} t={t} />}
        >
          <DailyChart series={series} range={range} data={data} f={f} t={t} />
        </Panel>
      </section>

      <section style={{ ...sectionStyle, ...twoColStyle }}>
        <Panel title={t('usage.mix.title')}>
          <TokenMix series={series} segments={data.segments} f={f} />
          <dl style={statListStyle}>
            <Stat label={t('usage.summary.totalTokens')} value={f.compact(avg.totalTokens)} title={f.full(avg.totalTokens)} />
            <Stat label={data.countLabel} value={f.compact(avg.totalCount)} title={f.full(avg.totalCount)} />
            <Stat
              label={t('usage.summary.perCount')}
              value={avg.totalCount > 0 ? f.compact(avg.totalTokens / avg.totalCount) : '—'}
            />
            <Stat
              label={t('usage.summary.peakDay')}
              value={avg.peak ? f.compact(avg.peak.total) : '—'}
              hint={avg.peak ? f.date(avg.peak.day) : undefined}
            />
            {data.stats.map((s) => (
              <Stat key={s.label} {...s} />
            ))}
          </dl>
        </Panel>
        <Panel title={t('usage.weekday.title')} subtitle={t('usage.weekday.hint')}>
          <WeekdayPattern series={series} f={f} />
        </Panel>
      </section>
    </>
  );
}

// ─── Building blocks ────────────────────────────────────────────────────────

function Panel({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.lg, marginBottom: space.lg, minHeight: 28 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: fontSize.lg, fontWeight: 600 }}>{title}</h2>
          {subtitle && <div style={{ fontSize: fontSize.sm, color: token('textMuted'), marginTop: 2 }}>{subtitle}</div>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

function KpiCard({
  label,
  value,
  title,
  unit,
  delta,
  deltaText,
  spark,
}: {
  label: string;
  value: string;
  title: string;
  unit?: string;
  delta?: number | null;
  deltaText: string;
  spark?: readonly FilledDay[];
}) {
  // An arrow, not red/green: more usage is neither good nor bad by itself.
  const arrow = delta == null || Math.abs(delta) < 0.005 ? '' : delta > 0 ? '▲ ' : '▼ ';
  return (
    <div style={{ ...panelStyle, padding: space.xl, position: 'relative', overflow: 'hidden' }}>
      <div style={{ fontSize: fontSize.sm, color: token('textMuted'), fontWeight: 500 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: space.xs, margin: `${space.sm}px 0` }} title={title}>
        <span style={{ fontSize: 26, fontWeight: 650, letterSpacing: -0.5, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        {unit && <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>{unit}</span>}
      </div>
      <div style={{ fontSize: fontSize.sm, color: token('textMuted'), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {arrow && <span style={{ color: token('text'), fontWeight: 600 }}>{arrow}</span>}
        {deltaText}
      </div>
      {spark && <Sparkline series={spark} />}
    </div>
  );
}

function Sparkline({ series }: { series: readonly FilledDay[] }) {
  const max = series.reduce((m, d) => Math.max(m, d.total), 0);
  if (max === 0) return null;
  const W = 72;
  const H = 28;
  const step = W / Math.max(series.length - 1, 1);
  const pts = series.map((d, i) => `${(i * step).toFixed(1)},${(H - (d.total / max) * (H - 2) - 1).toFixed(1)}`);
  return (
    <svg
      width={W}
      height={H}
      aria-hidden
      style={{ position: 'absolute', right: space.xl, top: space.xl, overflow: 'visible' }}
    >
      <polyline points={pts.join(' ')} style={{ fill: 'none', stroke: token('accent'), strokeWidth: 1.5, strokeLinejoin: 'round' }} />
      <circle cx={(series.length - 1) * step} cy={pts[pts.length - 1]?.split(',')[1]} r={2.5} style={{ fill: token('accent') }} />
    </svg>
  );
}

function RangeSwitch({
  value,
  onChange,
  max,
  t,
}: {
  value: Range;
  onChange: (r: Range) => void;
  max: number;
  t: TranslateFn;
}) {
  const options = RANGES.filter((r) => r <= Math.max(max, RANGES[0]));
  return (
    <div role="group" aria-label={t('usage.chart.rangeLabel')} style={segmentedRootStyle}>
      {options.map((r, i) => {
        const active = r === value;
        return (
          <button
            key={r}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(r)}
            style={{
              ...segmentButtonChrome('sm'),
              borderLeft: i === 0 ? 'none' : `1px solid ${token('border')}`,
              background: active ? token('accent') : 'transparent',
              color: active ? token('accentText') : token('text'),
              cursor: active ? 'default' : 'pointer',
            }}
          >
            {fill(t('usage.chart.range'), { days: String(r) })}
          </button>
        );
      })}
    </div>
  );
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const CHART_H = 240;
const PAD = { top: 16, right: 8, bottom: 24, left: 52 };

function DailyChart({
  series: full,
  range,
  data,
  f,
  t,
}: {
  series: readonly FilledDay[];
  range: Range;
  data: DashboardData;
  f: Formatters;
  t: TranslateFn;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const n = Math.min(range, full.length);
  const offset = full.length - n;
  const series = full.slice(offset);
  // Moving average is computed on the FULL series so the line's first visible point already
  // includes the days just left of the window.
  const trend = trailingAverage(full, TREND_WINDOW).slice(offset);
  const rangeAvg = rangeAverage(full, n);

  const maxVal = Math.max(rangeAvg, ...series.map((d) => d.total), ...trend.map((v) => v ?? 0));
  const yMax = niceCeil(maxVal);
  const plotW = Math.max(width - PAD.left - PAD.right, 0);
  const plotH = CHART_H - PAD.top - PAD.bottom;
  const slot = n > 0 ? plotW / n : 0;
  const barW = Math.max(Math.min(slot * 0.66, 28), 1);
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const xCenter = (i: number) => PAD.left + slot * i + slot / 2;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(Math.floor(plotW / 56), 1)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => r * yMax);

  const trendPts = trend
    .map((v, i) => (v === null ? null : `${xCenter(i).toFixed(1)},${y(v).toFixed(1)}`))
    .filter((p): p is string => p !== null);

  const hovered = hover === null ? null : series[hover];
  const empty = series.every((d) => d.total === 0);
  const avgLabel = fill(t('usage.chart.avgLine'), { value: f.compact(rangeAvg) });

  return (
    <div>
      <div ref={ref} style={{ position: 'relative', height: CHART_H }} onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg
            width={width}
            height={CHART_H}
            role="img"
            aria-label={`${t('usage.chart.title')} · ${avgLabel}`}
            style={{ display: 'block', overflow: 'visible' }}
          >
            {/* Grid + y axis */}
            {ticks.map((v) => (
              <g key={v}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y(v)}
                  y2={y(v)}
                  style={{ stroke: token('border'), strokeWidth: 1, strokeDasharray: v === 0 ? undefined : '2 4' }}
                />
                <text
                  x={PAD.left - 8}
                  y={y(v)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  style={{ fill: token('textMuted'), fontSize: fontSize.xs, fontVariantNumeric: 'tabular-nums' }}
                >
                  {f.compact(v)}
                </text>
              </g>
            ))}

            {/* Hover column */}
            {hover !== null && (
              <rect
                x={PAD.left + slot * hover}
                y={PAD.top}
                width={slot}
                height={plotH}
                rx={radius.sm}
                style={{ fill: token('surfaceHover') }}
              />
            )}

            {/* Stacked bars */}
            {series.map((d, i) => {
              let acc = 0;
              const x = xCenter(i) - barW / 2;
              const dim = hover !== null && hover !== i;
              return (
                <g key={d.day} style={{ opacity: dim ? 0.55 : 1 }}>
                  {d.segments.map((v, s) => {
                    if (v <= 0) return null;
                    const top = y(acc + v);
                    const h = Math.max(y(acc) - top, 1);
                    acc += v;
                    return (
                      <rect
                        key={s}
                        x={x}
                        y={top}
                        width={barW}
                        height={h}
                        style={{ fill: token(data.segments[s]?.color ?? 'accent') }}
                      />
                    );
                  })}
                </g>
              );
            })}

            {/* Range average line */}
            {!empty && (
              <g>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y(rangeAvg)}
                  y2={y(rangeAvg)}
                  style={{ stroke: token('text'), strokeWidth: 1, strokeDasharray: '5 4', opacity: 0.7 }}
                />
                <AvgTag x={width - PAD.right} y={y(rangeAvg)} label={avgLabel} />
              </g>
            )}

            {/* Moving average */}
            {trendPts.length > 1 && (
              <polyline
                points={trendPts.join(' ')}
                style={{ fill: 'none', stroke: token('chartTrend'), strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }}
              />
            )}
            {hover !== null && trend[hover] !== null && (
              <circle cx={xCenter(hover)} cy={y(trend[hover]!)} r={3.5} style={{ fill: token('bg'), stroke: token('chartTrend'), strokeWidth: 2 }} />
            )}

            {/* X labels */}
            {series.map((d, i) =>
              (n - 1 - i) % labelEvery === 0 ? (
                <text
                  key={d.day}
                  x={xCenter(i)}
                  y={CHART_H - 6}
                  textAnchor="middle"
                  style={{ fill: token('textMuted'), fontSize: fontSize.xs, fontVariantNumeric: 'tabular-nums' }}
                >
                  {d.day.slice(5)}
                </text>
              ) : null,
            )}

            {/* Hit targets */}
            {series.map((d, i) => (
              <rect
                key={d.day}
                x={PAD.left + slot * i}
                y={PAD.top}
                width={slot}
                height={plotH}
                style={{ fill: 'transparent' }}
                onMouseEnter={() => setHover(i)}
              />
            ))}
          </svg>
        )}
        {hovered && hover !== null && (
          <ChartTooltip
            day={hovered}
            trend={trend[hover] ?? null}
            avg={rangeAvg}
            x={xCenter(hover)}
            width={width}
            data={data}
            f={f}
            t={t}
          />
        )}
      </div>
      <Legend
        items={[
          ...data.segments.map((s) => ({ label: s.label, color: s.color, kind: 'box' as const })),
          { label: fill(t('usage.chart.trend'), { days: String(TREND_WINDOW) }), color: 'chartTrend' as const, kind: 'line' as const },
          { label: t('usage.chart.avgLegend'), color: 'text' as const, kind: 'dash' as const },
        ]}
      />
    </div>
  );
}

function AvgTag({ x, y, label }: { x: number; y: number; label: string }) {
  // Approximate width — SVG can't measure text before layout, and a pill that's a few px
  // generous reads fine.
  const w = label.length * 6.4 + 12;
  return (
    <g transform={`translate(${x - w}, ${y - 20})`}>
      <rect width={w} height={16} rx={radius.pill} style={{ fill: token('text') }} />
      <text
        x={w / 2}
        y={8}
        textAnchor="middle"
        dominantBaseline="central"
        style={{ fill: token('bg'), fontSize: fontSize.xs, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
      >
        {label}
      </text>
    </g>
  );
}

function ChartTooltip({
  day,
  trend,
  avg,
  x,
  width,
  data,
  f,
  t,
}: {
  day: FilledDay;
  trend: number | null;
  avg: number;
  x: number;
  width: number;
  data: DashboardData;
  f: Formatters;
  t: TranslateFn;
}) {
  const right = x > width * 0.6;
  const vsAvg = avg > 0 ? (day.total - avg) / avg : null;
  return (
    <div
      role="status"
      style={{
        position: 'absolute',
        top: 0,
        ...(right ? { right: width - x + 14 } : { left: x + 14 }),
        minWidth: 180,
        padding: `${space.md}px ${space.lg}px`,
        borderRadius: radius.md,
        border: `1px solid ${token('border')}`,
        background: token('bg'),
        boxShadow: elevation('menu'),
        fontSize: fontSize.sm,
        pointerEvents: 'none',
        zIndex: 1,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: space.sm }}>{f.date(day.day)}</div>
      <TipRow label={t('usage.summary.totalTokens')} value={f.full(day.total)} strong />
      {data.segments.map((s, i) => (
        <TipRow key={s.label} label={s.label} value={f.full(day.segments[i] ?? 0)} color={s.color} />
      ))}
      <TipRow label={data.countLabel} value={f.full(day.count)} />
      <div style={{ borderTop: `1px solid ${token('border')}`, margin: `${space.sm}px 0` }} />
      {trend !== null && (
        <TipRow label={fill(t('usage.chart.trend'), { days: String(TREND_WINDOW) })} value={f.full(trend)} color="chartTrend" />
      )}
      {vsAvg !== null && <TipRow label={t('usage.chart.vsAvg')} value={f.signedPct(vsAvg)} />}
    </div>
  );
}

function TipRow({ label, value, color, strong }: { label: string; value: string; color?: TokenName; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: space.md, lineHeight: '20px' }}>
      {color && <span style={{ width: 8, height: 8, borderRadius: 2, background: token(color), flexShrink: 0 }} />}
      <span style={{ flex: 1, color: token('textMuted') }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: strong ? 600 : 400 }}>{value}</span>
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: TokenName; kind: 'box' | 'line' | 'dash' }[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${space.sm}px ${space.xl}px`, marginTop: space.md, paddingLeft: PAD.left }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: space.sm, fontSize: fontSize.sm, color: token('textMuted') }}>
          {it.kind === 'box' ? (
            <span style={{ width: 10, height: 10, borderRadius: 2, background: token(it.color) }} />
          ) : (
            <span
              style={{
                width: 16,
                height: 0,
                borderTop: `${it.kind === 'line' ? 2 : 1}px ${it.kind === 'line' ? 'solid' : 'dashed'} ${token(it.color)}`,
              }}
            />
          )}
          {it.label}
        </span>
      ))}
    </div>
  );
}

function TokenMix({
  series,
  segments,
  f,
}: {
  series: readonly FilledDay[];
  segments: readonly DashboardSegment[];
  f: Formatters;
}) {
  const totals = segments.map((_, i) => series.reduce((a, d) => a + (d.segments[i] ?? 0), 0));
  const sum = totals.reduce((a, b) => a + b, 0);
  if (sum === 0) return null;
  return (
    <div style={{ marginBottom: space.xl }}>
      <div style={{ display: 'flex', height: 10, borderRadius: radius.pill, overflow: 'hidden', gap: 2, background: token('surfaceHover') }}>
        {totals.map((v, i) =>
          v > 0 ? <div key={i} style={{ flex: v, background: token(segments[i]?.color ?? 'accent') }} /> : null,
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${segments.length}, 1fr)`, gap: space.md, marginTop: space.lg }}>
        {segments.map((s, i) => (
          <div key={s.label} title={f.full(totals[i] ?? 0)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, fontSize: fontSize.sm, color: token('textMuted') }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: token(s.color) }} />
              {s.label}
            </div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
              {f.pct((totals[i] ?? 0) / sum)}
            </div>
            <div style={{ fontSize: fontSize.xs, color: token('textMuted'), fontVariantNumeric: 'tabular-nums' }}>{f.compact(totals[i] ?? 0)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, hint, title }: DashboardStat & { title?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: space.md, padding: `${space.sm}px 0`, borderTop: `1px solid ${token('border')}` }}>
      <dt style={{ flex: 1, fontSize: fontSize.base, color: token('textMuted') }}>{label}</dt>
      {hint && <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>{hint}</span>}
      <dd style={{ margin: 0, fontSize: fontSize.md, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }} title={title}>
        {value}
      </dd>
    </div>
  );
}

function WeekdayPattern({ series, f }: { series: readonly FilledDay[]; f: Formatters }) {
  const first = series.findIndex((d) => d.total > 0 || d.count > 0);
  const sums = Array(7).fill(0) as number[];
  const counts = Array(7).fill(0) as number[];
  if (first >= 0) {
    for (const d of series.slice(first)) {
      const wd = weekdayOf(d.day);
      sums[wd] = (sums[wd] ?? 0) + d.total;
      counts[wd] = (counts[wd] ?? 0) + 1;
    }
  }
  const avgs = sums.map((s, i) => ((counts[i] ?? 0) > 0 ? s / (counts[i] ?? 1) : 0));
  const max = Math.max(...avgs, 0);
  const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first
  const top = max > 0 ? avgs.indexOf(max) : -1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
      {order.map((wd) => (
        <div key={wd} style={{ display: 'flex', alignItems: 'center', gap: space.lg, fontSize: fontSize.sm }}>
          <span style={{ width: 40, color: token('textMuted'), flexShrink: 0 }}>{f.weekday(wd)}</span>
          <div style={{ flex: 1, height: 14, borderRadius: radius.sm, background: token('surfaceHover'), overflow: 'hidden' }}>
            <div
              style={{
                width: `${max > 0 ? ((avgs[wd] ?? 0) / max) * 100 : 0}%`,
                height: '100%',
                borderRadius: radius.sm,
                background: token('accent'),
                opacity: wd === top ? 1 : 0.6,
              }}
            />
          </div>
          <span style={{ width: 56, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: wd === top ? 600 : 400 }}>
            {f.compact(avgs[wd] ?? 0)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Breakdown table (shared by both sources) ───────────────────────────────

export interface BreakdownColumn<R> {
  label: string;
  value: (row: R) => number;
}

export function BreakdownPanel<R extends { key: string; totalTokens: number }>({
  heading,
  rows,
  label,
  columns,
  t,
}: {
  heading: string;
  rows: readonly R[];
  label: (key: string) => string;
  columns: readonly BreakdownColumn<R>[];
  t: TranslateFn;
}) {
  const f = useFormatters();
  if (rows.length === 0) return null;
  const sum = rows.reduce((a, r) => a + r.totalTokens, 0);
  return (
    <section style={sectionStyle}>
      <Panel title={heading}>
        <div style={{ overflowX: 'auto', margin: `0 -${space.xl}px -${space.md}px` }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: fontSize.md }}>
            <thead>
              <tr>
                <th style={thStyle}>{t('usage.table.name')}</th>
                <th style={{ ...thStyle, width: '28%' }}>{t('usage.table.share')}</th>
                {columns.map((c) => (
                  <th key={c.label} style={thNumStyle}>{c.label}</th>
                ))}
                <th style={thNumStyle}>{t('usage.table.totalTokens')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const share = sum > 0 ? r.totalTokens / sum : 0;
                return (
                  <tr key={r.key} style={{ borderTop: `1px solid ${token('border')}` }}>
                    <td style={{ ...tdStyle, fontWeight: 500, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label(r.key)}>
                      {label(r.key)}
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: space.md }}>
                        <div style={{ flex: 1, height: 6, borderRadius: radius.pill, background: token('surfaceHover'), overflow: 'hidden' }}>
                          <div style={{ width: `${share * 100}%`, height: '100%', background: token('accent'), borderRadius: radius.pill }} />
                        </div>
                        <span style={{ width: 36, textAlign: 'right', fontSize: fontSize.sm, color: token('textMuted'), fontVariantNumeric: 'tabular-nums' }}>
                          {f.pct(share)}
                        </span>
                      </div>
                    </td>
                    {columns.map((c) => (
                      <td key={c.label} style={tdNumStyle} title={f.full(c.value(r))}>
                        {f.compact(c.value(r))}
                      </td>
                    ))}
                    <td style={{ ...tdNumStyle, fontWeight: 600 }} title={f.full(r.totalTokens)}>
                      {f.compact(r.totalTokens)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </section>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const sectionStyle: CSSProperties = { marginBottom: space.xl };

const panelStyle: CSSProperties = {
  border: `1px solid ${token('border')}`,
  borderRadius: radius.lg,
  background: token('surface'),
  padding: space.xl,
};

const kpiGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: space.lg,
};

const twoColStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: space.lg,
};

const statListStyle: CSSProperties = { margin: 0 };

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: `${space.md}px ${space.xl}px`,
  fontSize: fontSize.sm,
  fontWeight: 600,
  color: token('textMuted'),
  whiteSpace: 'nowrap',
};
const thNumStyle: CSSProperties = { ...thStyle, textAlign: 'right' };
const tdStyle: CSSProperties = { padding: `${space.md + 2}px ${space.xl}px` };
const tdNumStyle: CSSProperties = { ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
