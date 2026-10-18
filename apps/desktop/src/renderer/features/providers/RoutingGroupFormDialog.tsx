// Create / edit a routing group (failover pool).
//
// Members are picked from real pool providers + their models. Strategy and affinity
// are the MVP set from shared/routingGroups. Writes go through the renderer provider
// store (IPC) — no secrets here.

import { useMemo, useState } from 'react';
import { disabledOpacity, elevation, token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import type { ProviderSummary } from '../../../shared/ipc-channels';
import type { RoutingAffinity, RoutingGroupMember, RoutingStrategy } from '../../../shared/routingGroups';
import { ROUTING_AFFINITIES, ROUTING_STRATEGIES } from '../../../shared/routingGroups';
import { addRoutingGroup, updateRoutingGroup } from '../../lib/providerStore';
import { providerErrorMessage } from './errors';
import { formatModelRef } from '../../../shared/modelRef';

export function RoutingGroupFormDialog({
  providers,
  initial,
  onClose,
}: {
  providers: ProviderSummary[];
  initial?: {
    id: string;
    name: string;
    members: RoutingGroupMember[];
    strategy: RoutingStrategy;
    affinity: RoutingAffinity;
  };
  onClose: () => void;
}) {
  const t = useT();
  const realProviders = useMemo(
    () => providers.filter((p) => !p.virtual && p.models.length > 0),
    [providers],
  );

  const [name, setName] = useState(initial?.name ?? '');
  const [strategy, setStrategy] = useState<RoutingStrategy>(initial?.strategy ?? 'ordered');
  const [affinity, setAffinity] = useState<RoutingAffinity>(initial?.affinity ?? 'session');
  const [members, setMembers] = useState<RoutingGroupMember[]>(
    initial?.members.map((m) => ({ ...m })) ?? [],
  );
  const [pickProviderId, setPickProviderId] = useState(realProviders[0]?.id ?? '');
  const pickProvider = realProviders.find((p) => p.id === pickProviderId) ?? null;
  const [pickModelId, setPickModelId] = useState(pickProvider?.models[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addMember(): void {
    if (!pickProviderId || !pickModelId) return;
    const key = `${pickProviderId}\0${pickModelId}`;
    if (members.some((m) => `${m.providerId}\0${m.modelId}` === key)) return;
    setMembers([...members, { providerId: pickProviderId, modelId: pickModelId }]);
  }

  function removeMember(index: number): void {
    setMembers(members.filter((_, i) => i !== index));
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const input = { name, members, strategy, affinity };
      if (initial) await updateRoutingGroup({ id: initial.id, ...input });
      else await addRoutingGroup(input);
      onClose();
    } catch (err) {
      setError(providerErrorMessage(t, err));
      setBusy(false);
    }
  }

  const canSave = name.trim() !== '' && members.length > 0 && !busy;

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true">
      <div style={panelStyle}>
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: fontSize['2xl'] }}>
            {initial ? t('providers.routingGroup.editTitle') : t('providers.routingGroup.addTitle')}
          </h2>
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

        <p style={{ margin: '0 0 16px', fontSize: fontSize.base, color: token('textMuted') }}>
          {t('providers.routingGroup.help')}
        </p>

        <label style={labelStyle}>
          {t('providers.routingGroup.name')}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
            disabled={busy}
          />
        </label>

        <div style={{ display: 'flex', gap: space.md, flexWrap: 'wrap', marginTop: space.lg }}>
          <label style={{ ...labelStyle, flex: '1 1 160px' }}>
            {t('providers.routingGroup.strategy')}
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as RoutingStrategy)}
              style={inputStyle}
              disabled={busy}
            >
              {ROUTING_STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {t(`providers.routingGroup.strategies.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label style={{ ...labelStyle, flex: '1 1 160px' }}>
            {t('providers.routingGroup.affinity')}
            <select
              value={affinity}
              onChange={(e) => setAffinity(e.target.value as RoutingAffinity)}
              style={inputStyle}
              disabled={busy}
            >
              {ROUTING_AFFINITIES.map((a) => (
                <option key={a} value={a}>
                  {t(`providers.routingGroup.affinities.${a}`)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ marginTop: space.lg }}>
          <div style={{ fontSize: fontSize.sm, color: token('textMuted'), marginBottom: space.sm }}>
            {t('providers.routingGroup.members')}
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: space.sm }}>
            {members.map((m, i) => {
              const p = realProviders.find((x) => x.id === m.providerId);
              const model = p?.models.find((x) => x.id === m.modelId);
              const label = p && model ? formatModelRef(p.name, model) : `${m.providerId} / ${m.modelId}`;
              return (
                <li
                  key={`${m.providerId}:${m.modelId}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: space.md,
                    padding: `${space.sm}px ${space.md}px`,
                    border: `1px solid ${token('border')}`,
                    borderRadius: radius.md,
                  }}
                >
                  <span style={{ fontSize: fontSize.base }}>
                    {i + 1}. {label}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => removeMember(i)}
                    {...hoverBackground('transparent', token('surfaceHover'))}
                    style={ghostBtnStyle}
                  >
                    {t('providers.routingGroup.removeMember')}
                  </button>
                </li>
              );
            })}
          </ul>

          <div
            style={{
              display: 'flex',
              gap: space.sm,
              flexWrap: 'wrap',
              marginTop: space.md,
              alignItems: 'flex-end',
            }}
          >
            <label style={{ ...labelStyle, flex: '1 1 140px' }}>
              {t('providers.routingGroup.memberProvider')}
              <select
                value={pickProviderId}
                onChange={(e) => {
                  const id = e.target.value;
                  setPickProviderId(id);
                  const next = realProviders.find((p) => p.id === id);
                  setPickModelId(next?.models[0]?.id ?? '');
                }}
                style={inputStyle}
                disabled={busy || realProviders.length === 0}
              >
                {realProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ ...labelStyle, flex: '1 1 140px' }}>
              {t('providers.routingGroup.memberModel')}
              <select
                value={pickModelId}
                onChange={(e) => setPickModelId(e.target.value)}
                style={inputStyle}
                disabled={busy || !pickProvider}
              >
                {(pickProvider?.models ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.alias ?? m.id}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy || !pickProviderId || !pickModelId}
              onClick={addMember}
              {...hoverBackground(token('surface'), token('surfaceHover'))}
              style={{
                ...ghostBtnStyle,
                border: `1px solid ${token('border')}`,
                opacity: busy || !pickProviderId || !pickModelId ? disabledOpacity : 1,
              }}
            >
              {t('providers.routingGroup.addMember')}
            </button>
          </div>
        </div>

        {error && (
          <p role="alert" style={{ margin: '12px 0 0', color: token('danger'), fontSize: fontSize.base }}>
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: space.md, justifyContent: 'flex-end', marginTop: 16 }}>
          <button
            type="button"
            onClick={onClose}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={ghostBtnStyle}
          >
            {t('providers.form.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave}
            {...hoverBackground(token('accent'), token('accentHover'))}
            style={{
              ...ghostBtnStyle,
              border: `1px solid ${token('accent')}`,
              background: token('accent'),
              color: token('accentText'),
              opacity: canSave ? 1 : disabledOpacity,
              cursor: canSave ? 'pointer' : 'default',
            }}
          >
            {busy ? t('providers.form.saving') : t('providers.form.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: token('overlay'),
  display: 'grid',
  placeItems: 'center',
  padding: space['2xl'],
  zIndex: 10,
} as const;

const panelStyle = {
  width: 'min(560px, 100%)',
  maxHeight: '100%',
  overflowY: 'auto',
  background: token('bg'),
  color: token('text'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.xl,
  boxShadow: elevation('modal'),
  padding: 20,
} as const;

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: space.md,
  marginBottom: space.md,
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

const labelStyle = {
  display: 'grid',
  gap: space.sm,
  fontSize: fontSize.sm,
  color: token('textMuted'),
} as const;

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box' as const,
  padding: `${space.sm}px ${space.md}px`,
  borderRadius: radius.md,
  border: `1px solid ${token('border')}`,
  background: token('surface'),
  color: token('text'),
  fontSize: fontSize.base,
};

const ghostBtnStyle = {
  border: 'none',
  background: 'transparent',
  color: token('text'),
  fontSize: fontSize.base,
  padding: `${space.sm}px ${space.md}px`,
  borderRadius: radius.md,
  cursor: 'pointer',
} as const;
