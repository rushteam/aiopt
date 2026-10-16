// Usage statistics view — a top-level screen (like ProvidersHome) showing the
// aggregated usage of PROXIED cross-format traffic.
//
// The snapshot is read from the renderer usage store (mirrored from main); the
// only write is "clear". Identifiers are resolved to display names locally: a
// providerId against the live providers snapshot, an agentId against the built-in
// agent registry — so a deleted provider degrades to a short id, never a crash.
//
// Two sources, picked with a segmented control:
//   · proxy — traffic that went through AiOpt's translation proxy (live, from main).
//   · local — token counts read main-side from the agents' own session logs (Claude Code,
//     Codex). This covers DIRECT bindings, which bypass the proxy. Read on demand.

import { useCallback, useEffect, useState } from 'react';
import { disabledOpacity, token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT, type TranslateFn } from '../../i18n';
import { useUsage } from '../../hooks/useUsage';
import { useProviders } from '../../hooks/useProviders';
import { clearUsage } from '../../lib/usageStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ScrollTabScreen, tabScreenSectionStyle } from '../../components/TabScreenShell';
import { AGENT_SPECS } from '../../../shared/aiProviders';
import type { UsageBucket, UsageSnapshot } from '../../../shared/usageStats';
import type { LocalUsageBucket, LocalUsageSnapshot } from '../../../shared/agentSessions';
import { BreakdownPanel, UsageDashboard, type BreakdownColumn, type DashboardData } from './UsageDashboard';
import { segmentButtonChrome, segmentedRootStyle } from '../../components/ui/controlStyles';
import { LoadingButton } from '../../components/ui/LoadingButton';

/** Display name for any agent id (including skills-only ones such as Cursor). */
const agentName = (id: string): string =>
  Object.hasOwn(AGENT_SPECS, id) ? AGENT_SPECS[id as keyof typeof AGENT_SPECS].name : id;

/** Agents whose local usage is estimated from conversation text, not read from logged counts. */
const ESTIMATED_AGENTS: ReadonlySet<string> = new Set(['cursor']);

type UsageSource = 'proxy' | 'local';

const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });

// ─── Source adapters: snapshot → dashboard data ──────────────────────────────

function proxyDashboard(usage: UsageSnapshot, t: TranslateFn): DashboardData {
  const { totals } = usage;
  const cacheable = totals.inputTokens + totals.cacheReadTokens;
  return {
    daily: usage.daily.map((d) => ({
      day: d.day,
      segments: [d.inputTokens, d.outputTokens, d.cacheReadTokens + d.cacheWriteTokens],
      count: d.requests,
    })),
    segments: [
      { label: t('usage.totals.inputTokens'), color: 'accent' },
      { label: t('usage.totals.outputTokens'), color: 'chartOutput' },
      { label: t('usage.table.cache'), color: 'chartCache' },
    ],
    retentionDays: usage.retentionDays,
    countLabel: t('usage.totals.requests'),
    stats: [
      {
        label: t('usage.totals.successRate'),
        value: totals.requests > 0 ? percent.format(totals.okRequests / totals.requests) : '—',
        hint: totals.errorRequests > 0 ? t('usage.summary.errors').replace('{{count}}', String(totals.errorRequests)) : undefined,
      },
      {
        label: t('usage.summary.outputRatio'),
        value: totals.inputTokens > 0 ? (totals.outputTokens / totals.inputTokens).toFixed(2) : '—',
      },
      {
        label: t('usage.summary.cacheHit'),
        value: cacheable > 0 ? percent.format(totals.cacheReadTokens / cacheable) : '—',
      },
      {
        label: t('usage.summary.reasoningShare'),
        value: totals.outputTokens > 0 ? percent.format(totals.reasoningTokens / totals.outputTokens) : '—',
      },
    ],
  };
}

function localDashboard(snap: LocalUsageSnapshot, t: TranslateFn): DashboardData {
  const { totals } = snap;
  const cacheable = totals.inputTokens + totals.cacheReadTokens;
  return {
    daily: snap.daily.map((d) => ({
      day: d.day,
      segments: [d.inputTokens, d.outputTokens, d.cacheReadTokens + d.cacheWriteTokens],
      count: d.responses,
    })),
    segments: [
      { label: t('usage.totals.inputTokens'), color: 'accent' },
      { label: t('usage.totals.outputTokens'), color: 'chartOutput' },
      { label: t('usage.local.cache'), color: 'chartCache' },
    ],
    retentionDays: snap.retentionDays,
    countLabel: t('usage.local.responses'),
    stats: [
      {
        label: t('usage.summary.cacheHit'),
        value: cacheable > 0 ? percent.format(totals.cacheReadTokens / cacheable) : '—',
      },
      { label: t('usage.summary.sessions'), value: String(snap.sessionCount) },
    ],
  };
}

function proxyColumns(t: TranslateFn): BreakdownColumn<UsageBucket>[] {
  return [
    { label: t('usage.table.requests'), value: (r) => r.requests },
    { label: t('usage.table.inputTokens'), value: (r) => r.inputTokens },
    { label: t('usage.table.outputTokens'), value: (r) => r.outputTokens },
    { label: t('usage.table.cache'), value: (r) => r.cacheReadTokens + r.cacheWriteTokens },
    { label: t('usage.table.reasoning'), value: (r) => r.reasoningTokens },
  ];
}

function localColumns(t: TranslateFn): BreakdownColumn<LocalUsageBucket>[] {
  return [
    { label: t('usage.local.responses'), value: (r) => r.responses },
    { label: t('usage.table.inputTokens'), value: (r) => r.inputTokens },
    { label: t('usage.table.outputTokens'), value: (r) => r.outputTokens },
    { label: t('usage.local.cache'), value: (r) => r.cacheReadTokens + r.cacheWriteTokens },
  ];
}

export function UsageHome() {
  const t = useT();
  const [source, setSource] = useState<UsageSource>('proxy');
  return (
    <ScrollTabScreen>
      {/* Visually hidden — the tab already names the screen. See ProvidersHome. */}
      <h1 className="sr-only">{t('usage.title')}</h1>
      <section style={{ ...tabScreenSectionStyle, display: 'flex', alignItems: 'center', gap: space.lg }}>
        <SourceSwitch value={source} onChange={setSource} t={t} />
        <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>
          {t(source === 'proxy' ? 'usage.source.proxyHint' : 'usage.source.localHint')}
        </span>
      </section>
      {source === 'proxy' ? <ProxyUsage /> : <LocalUsage />}
    </ScrollTabScreen>
  );
}

function SourceSwitch({
  value,
  onChange,
  t,
}: {
  value: UsageSource;
  onChange: (next: UsageSource) => void;
  t: TranslateFn;
}) {
  const options: UsageSource[] = ['proxy', 'local'];
  return (
    <div role="group" aria-label={t('usage.source.label')} style={segmentedRootStyle}>
      {options.map((opt, index) => {
        const active = value === opt;
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt)}
            style={{
              ...segmentButtonChrome('md'),
              borderLeft: index === 0 ? 'none' : `1px solid ${token('border')}`,
              background: active ? token('accent') : 'transparent',
              color: active ? token('accentText') : token('text'),
              cursor: active ? 'default' : 'pointer',
            }}
          >
            {t(`usage.source.${opt}`)}
          </button>
        );
      })}
    </div>
  );
}

function LocalUsage() {
  const t = useT();
  const [snap, setSnap] = useState<LocalUsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback((refresh: boolean) => {
    setLoading(true);
    setFailed(false);
    window.aiopt.sessions
      .localUsage({ refresh })
      .then(setSnap)
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(false), [load]);

  return (
    <>
      {failed ? (
        <p role="alert" style={{ fontSize: fontSize.md, color: token('danger') }}>{t('usage.local.failed')}</p>
      ) : !snap ? (
        <p style={{ fontSize: fontSize.md, color: token('textMuted') }}>{t('usage.local.loading')}</p>
      ) : snap.totals.responses === 0 ? (
        <p style={{ fontSize: fontSize.md, color: token('textMuted') }}>{t('usage.local.empty')}</p>
      ) : (
        <>
          <UsageDashboard data={localDashboard(snap, t)} t={t} />
          <BreakdownPanel
            heading={t('usage.breakdown.byAgent')}
            rows={snap.byAgent}
            label={(id) => (ESTIMATED_AGENTS.has(id) ? `${agentName(id)} (${t('usage.local.estimated')})` : agentName(id))}
            columns={localColumns(t)}
            t={t}
          />
          <BreakdownPanel heading={t('usage.breakdown.byModel')} rows={snap.byModel} label={(k) => k} columns={localColumns(t)} t={t} />
        </>
      )}
      <section style={{ ...tabScreenSectionStyle, marginTop: 0, display: 'flex', alignItems: 'center', gap: space.md }}>
        <LoadingButton variant="ghost" loading={loading} onClick={() => load(true)}>
          {t('usage.local.refresh')}
        </LoadingButton>
        {snap && (
          <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>
            {t('usage.local.window').replace('{{days}}', String(snap.retentionDays))}
          </span>
        )}
      </section>
    </>
  );
}

function ProxyUsage() {
  const t = useT();
  const usage = useUsage();
  const { providers } = useProviders();
  const [confirmClear, setConfirmClear] = useState(false);

  const providerName = (id: string): string =>
    providers.find((p) => p.id === id)?.name ?? `${id.slice(0, 8)}…`;

  return (
    <>
      {usage.eventCount === 0 ? (
        <p style={{ fontSize: fontSize.md, color: token('textMuted') }}>{t('usage.empty')}</p>
      ) : (
        <>
          <UsageDashboard data={proxyDashboard(usage, t)} t={t} />
          <BreakdownPanel heading={t('usage.breakdown.byProvider')} rows={usage.byProvider} label={providerName} columns={proxyColumns(t)} t={t} />
          <BreakdownPanel heading={t('usage.breakdown.byAgent')} rows={usage.byAgent} label={agentName} columns={proxyColumns(t)} t={t} />
          <BreakdownPanel heading={t('usage.breakdown.byModel')} rows={usage.byModel} label={(k) => k} columns={proxyColumns(t)} t={t} />
        </>
      )}

      <section style={{ ...tabScreenSectionStyle, marginTop: 0, display: 'flex', alignItems: 'center', gap: space.md }}>
        <button
          type="button"
          onClick={() => setConfirmClear(true)}
          disabled={usage.eventCount === 0}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={{ ...ghostStyle, opacity: usage.eventCount === 0 ? disabledOpacity : 1 }}
        >
          {t('usage.clear')}
        </button>
      </section>
      {confirmClear && (
        <ConfirmDialog
          title={t('usage.clearConfirm')}
          confirmLabel={t('usage.clearConfirmYes')}
          cancelLabel={t('usage.clearCancel')}
          danger
          onConfirm={() => {
            setConfirmClear(false);
            void clearUsage();
          }}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </>
  );
}

const ghostStyle = {
  padding: '8px 16px',
  borderRadius: radius.md,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.md,
} as const;
