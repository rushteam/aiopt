// Live routing status for the Providers page: per-member state on each routing-group card,
// and a "recent routing" drawer listing the last decisions.
//
// Everything shown comes from the in-memory status snapshot (lib/routingStatusStore): ids,
// status codes and times only. Affinity is a count of pinned sessions, never the keys.

import { useEffect, useMemo, useState } from 'react';
import { elevation, fontSize, radius, space, token, type TokenName } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useI18n, type TranslateFn } from '../../i18n';
import type { ProviderSummary } from '../../../shared/ipc-channels';
import type { RoutingGroupSummary } from '../../../shared/routingGroups';
import type { RoutingDecision, RoutingGroupStatus, RoutingMemberStatus } from '../../../shared/routingStatus';
import { AGENT_SPECS } from '../../../shared/aiProviders';
import { formatModelRef } from '../../../shared/modelRef';
import { retryRoutingMemberNow } from '../../lib/routingStatusStore';

/** Series colors for the hit-share bar, in member order (cycled). */
const HIT_COLORS: TokenName[] = ['accent', 'chartOutput', 'chartCache', 'chartTrend'];

/** A clock that ticks every second only while `active` (cooldown countdowns). */
export function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** `provider-slug/model` for a member, falling back to raw ids when it is gone. */
export function memberLabel(providers: ProviderSummary[], providerId: string, modelId: string): string {
  const p = providers.find((x) => x.id === providerId);
  const model = p?.models.find((x) => x.id === modelId);
  return p && model ? formatModelRef(p.name, model) : `${providerId}/${modelId}`;
}

const agentName = (id: string): string =>
  Object.hasOwn(AGENT_SPECS, id) ? AGENT_SPECS[id as keyof typeof AGENT_SPECS].name : id;

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function clockTime(at: number, locale: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function isCooling(m: RoutingMemberStatus, now: number): boolean {
  return m.coolingUntil !== null && m.coolingUntil > now;
}

/** Live member rows + last-hour summary inside a routing-group card. */
export function RoutingGroupLiveStatus({
  group,
  status,
  providers,
  t,
}: {
  group: RoutingGroupSummary;
  status: RoutingGroupStatus | undefined;
  providers: ProviderSummary[];
  t: TranslateFn;
}) {
  const members = status?.members ?? [];
  const anyCooling = members.some((m) => m.coolingUntil !== null);
  const now = useTickingNow(anyCooling);
  const [busySeat, setBusySeat] = useState<string | null>(null);
  const hour = status?.lastHour;
  const hitsTotal = hour ? hour.hits.reduce((a, b) => a + b, 0) : 0;

  return (
    <div style={{ display: 'grid', gap: space.sm }}>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: space.xs }}>
        {group.members.map((member, i) => {
          const live = members[i];
          const cooling = live ? isCooling(live, now) : false;
          const seat = `${member.providerId}:${member.modelId}`;
          const dot: TokenName = cooling ? 'warning' : live?.lastOkAt != null ? 'success' : 'textMuted';
          const left = cooling && live?.coolingUntil ? Math.max(1, Math.ceil((live.coolingUntil - now) / 1000)) : 0;
          return (
            <li key={seat} style={memberRowStyle}>
              <span
                aria-hidden
                style={{ width: 8, height: 8, borderRadius: radius.pill, background: token(dot), flex: '0 0 auto' }}
              />
              <span style={memberNameStyle} title={memberLabel(providers, member.providerId, member.modelId)}>
                {memberLabel(providers, member.providerId, member.modelId)}
              </span>
              {live?.next && <span style={badgeStyle}>{t('providers.routingStatus.next')}</span>}
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: space.sm }}>
                {cooling ? (
                  <>
                    <span style={{ color: token('textMuted') }}>
                      {t('providers.routingStatus.cooling').replace('{{s}}', String(left))}
                    </span>
                    <button
                      type="button"
                      disabled={busySeat === seat}
                      onClick={() => {
                        setBusySeat(seat);
                        void retryRoutingMemberNow(group.id, member.providerId, member.modelId)
                          .catch(() => {})
                          .finally(() => setBusySeat(null));
                      }}
                      title={t('providers.routingStatus.retryNowHint')}
                      {...hoverBackground('transparent', token('surfaceHover'))}
                      style={smallGhostStyle}
                    >
                      {t('providers.routingStatus.retryNow')}
                    </button>
                  </>
                ) : (
                  <span style={{ color: token('textMuted') }}>
                    {live && live.okCount > 0
                      ? t('providers.routingStatus.okCount').replace('{{count}}', String(live.okCount))
                      : t('providers.routingStatus.ready')}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {hour && hour.requests > 0 ? (
        <div style={{ display: 'grid', gap: space.xs }}>
          <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>
            {t('providers.routingStatus.summary')
              .replace('{{count}}', String(hour.requests))
              .replace('{{failovers}}', String(hour.failovers))}
          </span>
          {hitsTotal > 0 && (
            <div role="img" aria-label={t('providers.routingStatus.hitShare')} style={hitBarStyle}>
              {hour.hits.map((h, i) =>
                h > 0 ? (
                  <span
                    key={i}
                    title={`${memberLabel(providers, group.members[i]?.providerId ?? '', group.members[i]?.modelId ?? '')} · ${h}`}
                    style={{ flex: `${h} 0 0`, background: token(HIT_COLORS[i % HIT_COLORS.length]!) }}
                  />
                ) : null,
              )}
            </div>
          )}
        </div>
      ) : (
        <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>
          {t('providers.routingStatus.noTraffic')}
        </span>
      )}
      {group.affinity === 'session' && (status?.pinnedSessions ?? 0) > 0 && (
        <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>
          {t('providers.routingStatus.pinned').replace('{{count}}', String(status?.pinnedSessions ?? 0))}
        </span>
      )}
    </div>
  );
}

/** Side drawer listing recent routing decisions, filterable by group and Agent. */
export function RecentRoutingDrawer({
  recent,
  groups,
  providers,
  initialGroupId,
  onClose,
}: {
  recent: RoutingDecision[];
  groups: RoutingGroupSummary[];
  providers: ProviderSummary[];
  initialGroupId?: string;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const [groupId, setGroupId] = useState(initialGroupId ?? '');
  const [agentId, setAgentId] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const agents = useMemo(() => [...new Set(recent.map((d) => d.agentId))].sort(), [recent]);
  const rows = recent.filter((d) => (!groupId || d.groupId === groupId) && (!agentId || d.agentId === agentId));
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? id;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={t('providers.routingStatus.recentTitle')}
        style={drawerStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
          <h2 style={{ margin: 0, fontSize: fontSize['2xl'] }}>{t('providers.routingStatus.recentTitle')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('providers.form.close')}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={closeButtonStyle}
          >
            ×
          </button>
        </div>
        <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted') }}>
          {t('providers.routingStatus.recentHelp')}
        </p>
        <div style={{ display: 'flex', gap: space.md, flexWrap: 'wrap' }}>
          <select
            aria-label={t('providers.routingGroup.heading')}
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            style={selectStyle}
          >
            <option value="">{t('providers.routingStatus.allGroups')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <select
            aria-label={t('providers.routingStatus.agent')}
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            style={selectStyle}
          >
            <option value="">{t('providers.routingStatus.allAgents')}</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {agentName(a)}
              </option>
            ))}
          </select>
        </div>

        {rows.length === 0 ? (
          <p style={{ margin: 0, fontSize: fontSize.md, color: token('textMuted') }}>
            {t('providers.routingStatus.recentEmpty')}
          </p>
        ) : (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: space.sm, overflowY: 'auto' }}>
            {rows.map((d) => (
              <li key={d.id} style={decisionStyle}>
                <div style={{ display: 'flex', gap: space.sm, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: radius.pill,
                      background: token(d.ok ? 'success' : 'danger'),
                      alignSelf: 'center',
                    }}
                  />
                  <strong style={{ fontSize: fontSize.base }}>{groupName(d.groupId)}</strong>
                  <span style={{ color: token('textMuted') }}>
                    {agentName(d.agentId)} · {t(`providers.routingGroup.strategies.${d.strategy}`)}
                    {d.sticky ? ` · ${t('providers.routingStatus.sticky')}` : ''}
                  </span>
                  <span style={{ marginLeft: 'auto', color: token('textMuted') }}>
                    {clockTime(d.at, locale)} · {seconds(d.ms)}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.xs, alignItems: 'center' }}>
                  {d.attempts.map((a, i) => (
                    <span key={i} style={{ display: 'inline-flex', gap: space.xs, alignItems: 'center' }}>
                      {i > 0 && <span style={{ color: token('textMuted') }}>→</span>}
                      <span style={{ color: token(a.ok ? 'text' : 'danger') }}>
                        {a.ok ? '✓' : '✕'} {memberLabel(providers, a.providerId, a.modelId)}{' '}
                        {a.status === 0 ? t('providers.routingStatus.unreachable') : a.status} · {seconds(a.ms)}
                      </span>
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        )}
      </aside>
    </div>
  );
}

const memberRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: space.sm,
  fontSize: fontSize.sm,
  minWidth: 0,
} as const;

const memberNameStyle = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
} as const;

const badgeStyle = {
  fontSize: fontSize.xs,
  color: token('accent'),
  border: `1px solid ${token('accent')}`,
  borderRadius: radius.pill,
  padding: `0 ${space.sm}px`,
  flex: '0 0 auto',
} as const;

const smallGhostStyle = {
  padding: `1px ${space.sm}px`,
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.xs,
} as const;

const hitBarStyle = {
  display: 'flex',
  gap: 2,
  height: 6,
  borderRadius: radius.pill,
  overflow: 'hidden',
} as const;

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: token('overlay'),
  display: 'flex',
  justifyContent: 'flex-end',
  zIndex: 10,
} as const;

const drawerStyle = {
  width: 'min(520px, 100%)',
  height: '100%',
  boxSizing: 'border-box',
  background: token('bg'),
  color: token('text'),
  borderLeft: `1px solid ${token('border')}`,
  boxShadow: elevation('modal'),
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: space.lg,
} as const;

const closeButtonStyle = {
  border: 'none',
  background: 'transparent',
  color: token('text'),
  fontSize: fontSize['2xl'],
  lineHeight: 1,
  cursor: 'pointer',
  padding: `0 ${space.sm}px`,
} as const;

const selectStyle = {
  padding: `${space.xs}px ${space.md}px`,
  borderRadius: radius.md,
  border: `1px solid ${token('borderStrong')}`,
  background: token('bg'),
  color: token('text'),
  fontSize: fontSize.base,
} as const;

const decisionStyle = {
  display: 'grid',
  gap: space.xs,
  padding: `${space.sm}px ${space.md}px`,
  border: `1px solid ${token('border')}`,
  borderRadius: radius.md,
  fontSize: fontSize.sm,
} as const;
