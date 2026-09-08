// Usage statistics view — a top-level screen (like ProvidersHome) showing the
// aggregated usage of PROXIED cross-format traffic.
//
// The snapshot is read from the renderer usage store (mirrored from main); the
// only write is "clear". Identifiers are resolved to display names locally: a
// providerId against the live providers snapshot, an agentId against the built-in
// agent registry — so a deleted provider degrades to a short id, never a crash.
//
// IMPORTANT (surfaced in the UI): same-format DIRECT bindings bypass the proxy, so
// AiOpt never sees their traffic. These numbers cover cross-format bindings only.

import { useState } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT, type TranslateFn } from '../../i18n';
import { useUsage } from '../../hooks/useUsage';
import { useProviders } from '../../hooks/useProviders';
import { clearUsage } from '../../lib/usageStore';
import { AGENTS } from '../../../shared/aiProviders';
import type { UsageBucket, UsageDailyPoint } from '../../../shared/usageStats';

const numberFormat = new Intl.NumberFormat();
function fmt(n: number): string {
  return numberFormat.format(n);
}

export function UsageHome({ onClose }: { onClose: () => void }) {
  const t = useT();
  const usage = useUsage();
  const { providers } = useProviders();
  const [confirmClear, setConfirmClear] = useState(false);

  const providerName = (id: string): string =>
    providers.find((p) => p.id === id)?.name ?? `${id.slice(0, 8)}…`;
  const agentName = (id: string): string => AGENTS.find((a) => a.id === id)?.name ?? id;

  const { totals } = usage;
  const successRate =
    totals.requests > 0 ? Math.round((totals.okRequests / totals.requests) * 100) : 0;

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', padding: '24px 24px 48px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ margin: '0 0 4px', fontSize: fontSize['3xl'] }}>{t('usage.title')}</h1>
            <p style={{ margin: '0 0 4px', color: token('textMuted'), fontSize: fontSize.md }}>
              {t('usage.subtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('usage.close')}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={closeStyle}
          >
            ×
          </button>
        </div>
        <p style={{ margin: '0 0 24px', color: token('textMuted'), fontSize: fontSize.sm }}>
          {t('usage.scopeNote')}
        </p>

        {usage.eventCount === 0 ? (
          <p style={{ fontSize: fontSize.md, color: token('textMuted') }}>{t('usage.empty')}</p>
        ) : (
          <>
            <section style={{ marginBottom: 32 }}>
              <div style={cardGridStyle}>
                <StatCard label={t('usage.totals.requests')} value={fmt(totals.requests)} />
                <StatCard label={t('usage.totals.successRate')} value={`${successRate}%`} />
                <StatCard label={t('usage.totals.inputTokens')} value={fmt(totals.inputTokens)} />
                <StatCard label={t('usage.totals.outputTokens')} value={fmt(totals.outputTokens)} />
                <StatCard label={t('usage.totals.totalTokens')} value={fmt(totals.totalTokens)} />
              </div>
            </section>

            <section style={{ marginBottom: 32 }}>
              <h2 style={sectionHeadingStyle}>{t('usage.chart.title')}</h2>
              <DailyChart daily={usage.daily} t={t} />
            </section>

            <BreakdownTable
              heading={t('usage.breakdown.byProvider')}
              rows={usage.byProvider}
              label={providerName}
              t={t}
            />
            <BreakdownTable
              heading={t('usage.breakdown.byAgent')}
              rows={usage.byAgent}
              label={agentName}
              t={t}
            />
            <BreakdownTable
              heading={t('usage.breakdown.byModel')}
              rows={usage.byModel}
              label={(k) => k}
              t={t}
            />
          </>
        )}

        <section style={{ marginTop: 32, display: 'flex', alignItems: 'center', gap: space.md }}>
          {confirmClear ? (
            <>
              <span style={{ fontSize: fontSize.md }}>{t('usage.clearConfirm')}</span>
              <button
                type="button"
                onClick={() => {
                  setConfirmClear(false);
                  void clearUsage();
                }}
                {...hoverBackground(token('danger'), token('dangerHover'))}
                style={dangerStyle}
              >
                {t('usage.clearConfirmYes')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                {...hoverBackground('transparent', token('surfaceHover'))}
                style={ghostStyle}
              >
                {t('usage.clearCancel')}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              disabled={usage.eventCount === 0}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={{ ...ghostStyle, opacity: usage.eventCount === 0 ? 0.5 : 1 }}
            >
              {t('usage.clear')}
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        border: `1px solid ${token('border')}`,
        borderRadius: radius.lg,
        background: token('surface'),
        padding: space.lg,
      }}
    >
      <div style={{ fontSize: fontSize.sm, color: token('textMuted'), marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: fontSize['2xl'], fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function DailyChart({ daily, t }: { daily: readonly UsageDailyPoint[]; t: TranslateFn }) {
  if (daily.length === 0) {
    return <p style={{ fontSize: fontSize.md, color: token('textMuted') }}>{t('usage.chart.empty')}</p>;
  }
  const max = daily.reduce((m, d) => Math.max(m, d.totalTokens), 0);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: space.xs,
        height: 140,
        padding: space.md,
        border: `1px solid ${token('border')}`,
        borderRadius: radius.lg,
        background: token('surface'),
        overflowX: 'auto',
      }}
    >
      {daily.map((d) => {
        const pct = max > 0 ? (d.totalTokens / max) * 100 : 0;
        return (
          <div
            key={d.day}
            title={`${d.day} · ${fmt(d.totalTokens)}`}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 14, flex: 1 }}
          >
            <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', width: '100%' }}>
              <div
                style={{
                  width: '100%',
                  minWidth: 8,
                  height: `${Math.max(pct, d.totalTokens > 0 ? 2 : 0)}%`,
                  background: token('accent'),
                  borderRadius: `${radius.sm}px ${radius.sm}px 0 0`,
                }}
              />
            </div>
            <span style={{ fontSize: fontSize.xs, color: token('textMuted'), whiteSpace: 'nowrap' }}>
              {d.day.slice(5)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function BreakdownTable({
  heading,
  rows,
  label,
  t,
}: {
  heading: string;
  rows: readonly UsageBucket[];
  label: (key: string) => string;
  t: TranslateFn;
}) {
  if (rows.length === 0) return null;
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={sectionHeadingStyle}>{heading}</h2>
      <div style={{ border: `1px solid ${token('border')}`, borderRadius: radius.lg, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: fontSize.md }}>
          <thead>
            <tr style={{ background: token('surface') }}>
              <th style={thStyle}>{t('usage.table.name')}</th>
              <th style={thNumStyle}>{t('usage.table.requests')}</th>
              <th style={thNumStyle}>{t('usage.table.inputTokens')}</th>
              <th style={thNumStyle}>{t('usage.table.outputTokens')}</th>
              <th style={thNumStyle}>{t('usage.table.totalTokens')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} style={{ borderTop: `1px solid ${token('border')}` }}>
                <td style={tdStyle}>{label(r.key)}</td>
                <td style={tdNumStyle}>{fmt(r.requests)}</td>
                <td style={tdNumStyle}>{fmt(r.inputTokens)}</td>
                <td style={tdNumStyle}>{fmt(r.outputTokens)}</td>
                <td style={tdNumStyle}>{fmt(r.totalTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const sectionHeadingStyle = { margin: '0 0 12px', fontSize: fontSize.xl } as const;

const cardGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
  gap: space.lg,
} as const;

const closeStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  padding: 0,
  borderRadius: radius.sm,
  border: 'none',
  background: 'transparent',
  color: token('textMuted'),
  cursor: 'pointer',
  fontSize: fontSize.xl,
  lineHeight: 1,
} as const;

const dangerStyle = {
  padding: '8px 16px',
  borderRadius: radius.md,
  border: `1px solid ${token('danger')}`,
  background: token('danger'),
  color: token('accentText'),
  cursor: 'pointer',
  fontSize: fontSize.md,
} as const;

const ghostStyle = {
  padding: '8px 16px',
  borderRadius: radius.md,
  border: `1px solid ${token('border')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.md,
} as const;

const thStyle = {
  textAlign: 'left',
  padding: '8px 12px',
  fontSize: fontSize.sm,
  fontWeight: 600,
  color: token('textMuted'),
} as const;

const thNumStyle = { ...thStyle, textAlign: 'right' } as const;

const tdStyle = { padding: '8px 12px' } as const;
const tdNumStyle = { ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as const;
