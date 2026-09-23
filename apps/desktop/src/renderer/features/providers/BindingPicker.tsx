// Pick which provider+model an agent uses — a master/detail modal over the pool.
//
// Left pane: the providers (compatible ones selectable; incompatible shown greyed
// with a "needs proxy" note so the constraint stays visible). Right pane: the models
// of the provider selected on the left. This scales to a large pool and to providers
// with long (auto-loaded) model lists — each side scrolls, the model side filters.
//
// Selecting a provider or a model only STAGES the choice (highlight, no write);
// nothing touches the agent config until the footer "Apply" button commits it.
// "Use default" stages the first (or already-bound) model. This makes the write an
// explicit, reversible step rather than a side effect of a stray click.
//
// When AiOpt already drives this agent, the left list gains a "restore default" entry
// at the top — a pseudo-provider whose single "model" is Default. Selecting it and
// pressing Apply hands the agent's real config back to its pre-AiOpt state (or deletes
// an AiOpt-created file) and clears the binding. That write is destructive, so the
// detail pane spells out the consequence and the Apply button turns danger-colored.

import { useMemo, useState } from 'react';
import { elevation, token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import type { AgentSummary, ProviderSummary } from '../../../shared/ipc-channels';
import type { ProviderModel } from '../../../shared/aiProviders';
import { setAgentBinding, restoreAgentDefault } from '../../lib/providerStore';
import { providerErrorMessage } from './errors';

const SEARCH_THRESHOLD = 8; // show the model filter only once a provider has many

// Sentinel id for the synthetic "restore default" row. It never collides with a real
// provider id (those are UUIDs / official-* slugs), so selecting it is unambiguous.
const RESTORE_ID = '__restore_default__';

// Display order for the model list: alphabetical by id, case-insensitive and
// number-aware (so gpt-4o sorts before gpt-4.1 → gpt-10 naturally). This is
// presentation only — the provider's stored model order is left untouched.
const compareModels = (a: ProviderModel, b: ProviderModel): number =>
  a.id.localeCompare(b.id, undefined, { sensitivity: 'base', numeric: true });

export function BindingPicker({
  agent,
  providers,
  onClose,
}: {
  agent: AgentSummary;
  providers: ProviderSummary[];
  onClose: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState('');

  // Compatible providers first, then incompatible (greyed) — a stable, scannable order.
  const ordered = useMemo(() => {
    const ok = (p: ProviderSummary) => agent.acceptedFormats.includes(p.apiFormat);
    return [...providers].sort((a, b) => Number(ok(b)) - Number(ok(a)));
  }, [providers, agent.acceptedFormats]);

  // The default model to stage for a provider: keep the live one if this is the bound
  // provider (don't clobber the user's pick), otherwise the first (sorted) model — so
  // Apply always has a sensible target the moment a provider is selected.
  function defaultModelFor(providerId: string, models: ProviderModel[]): string | undefined {
    const live = agent.binding?.providerId === providerId ? agent.binding.modelId : undefined;
    return live ?? [...models].sort(compareModels)[0]?.id;
  }

  // Open on the currently-bound provider, else the first compatible one.
  const initialSelected =
    agent.binding?.providerId ??
    ordered.find((p) => agent.acceptedFormats.includes(p.apiFormat))?.id ??
    ordered[0]?.id ??
    null;
  const [selectedId, setSelectedId] = useState<string | null>(initialSelected);
  // The staged (not-yet-applied) model within the selected provider. Selecting a
  // provider or a model only moves this; Apply is what writes it.
  const [pendingModelId, setPendingModelId] = useState<string | undefined>(() => {
    const p = initialSelected ? ordered.find((x) => x.id === initialSelected) : undefined;
    return p ? defaultModelFor(p.id, p.models) : undefined;
  });

  // Restore is offered only while AiOpt is actively pointing this agent somewhere.
  const canRestore = agent.binding != null;
  const isRestoreSelected = selectedId === RESTORE_ID;

  const selected = ordered.find((p) => p.id === selectedId) ?? null;
  const selectedCompatible = selected
    ? agent.acceptedFormats.includes(selected.apiFormat)
    : false;

  const sortedModels = useMemo(
    () => (selected ? [...selected.models].sort(compareModels) : []),
    [selected],
  );

  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (q === '') return sortedModels;
    return sortedModels.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.alias?.toLowerCase().includes(q) ?? false),
    );
  }, [sortedModels, modelQuery]);

  async function choose(providerId: string, modelId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await setAgentBinding(agent.id, providerId, modelId);
      onClose();
    } catch (err) {
      setError(providerErrorMessage(t, err));
      setBusy(false);
    }
  }

  // Hand the agent's real config back to its pre-AiOpt state and clear the binding.
  async function doRestore(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await restoreAgentDefault(agent.id);
      onClose();
    } catch (err) {
      setError(providerErrorMessage(t, err));
      setBusy(false);
    }
  }

  // Stage (not commit) the default model for the selected provider.
  function stageDefault(): void {
    if (!selected) return;
    setPendingModelId(defaultModelFor(selected.id, selected.models));
  }

  // Apply commits the staged choice: a provider+model binding, or — when the restore
  // entry is selected — the config handback. Enabled once we have a valid target and idle.
  const canApply = isRestoreSelected
    ? !busy
    : selectedCompatible && pendingModelId !== undefined && !busy;
  function apply(): void {
    if (isRestoreSelected) {
      void doRestore();
      return;
    }
    if (selected && pendingModelId !== undefined) void choose(selected.id, pendingModelId);
  }

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true">
      <div style={panelStyle}>
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: fontSize['2xl'] }}>
            {t('providers.binding.title')}: {agent.name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('providers.form.close')}
            title={t('providers.form.close')}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={closeButtonStyle}
          >
            ×
          </button>
        </div>
        <p style={{ margin: '0 0 16px', fontSize: fontSize.base, color: token('textMuted') }}>
          {t('providers.binding.help')}
        </p>

        {providers.length === 0 ? (
          <p style={{ fontSize: fontSize.base, color: token('textMuted') }}>
            {t('providers.binding.noProviders')}
          </p>
        ) : (
          <div style={panesStyle}>
            {/* Left: providers, with the restore-default entry pinned on top */}
            <ul style={providerListStyle}>
              {canRestore && (
                <li>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setSelectedId(RESTORE_ID);
                      setModelQuery('');
                    }}
                    {...hoverBackground(
                      isRestoreSelected ? token('surfaceHover') : 'transparent',
                      token('surfaceHover'),
                    )}
                    style={restoreRowStyle(isRestoreSelected)}
                  >
                    <span style={{ fontWeight: 600 }}>{t('providers.agent.restoreDefault')}</span>
                  </button>
                </li>
              )}
              {ordered.map((provider) => {
                const compatible = agent.acceptedFormats.includes(provider.apiFormat);
                const isSelected = provider.id === selectedId;
                const isBound = agent.binding?.providerId === provider.id;
                return (
                  <li key={provider.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setSelectedId(provider.id);
                        setModelQuery('');
                        setPendingModelId(defaultModelFor(provider.id, provider.models));
                      }}
                      {...hoverBackground(
                        isSelected ? token('surfaceHover') : 'transparent',
                        token('surfaceHover'),
                      )}
                      style={providerRowStyle(isSelected, compatible)}
                    >
                      <span style={providerNameRowStyle}>
                        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {provider.name}
                        </span>
                        {isBound && (
                          <>
                            <span style={boundDotStyle} aria-hidden />
                            <span className="sr-only">{t('providers.binding.bound')}</span>
                          </>
                        )}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
                        <span style={badgeStyle}>{t(`providers.formats.${provider.apiFormat}`)}</span>
                        {!compatible && (
                          <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>
                            {t('providers.binding.needsProxy')}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Right: models of the selected provider (or the restore explanation) */}
            <div style={detailStyle}>
              {isRestoreSelected ? (
                <>
                  <p style={{ margin: 0, fontSize: fontSize.base, color: token('danger') }}>
                    {t('providers.agent.restoreConfirm')}
                  </p>
                  <div style={modelListStyle}>
                    {/* The lone, always-staged "model" for this entry. */}
                    <div style={modelRowStyle(true)}>
                      <span>{t('providers.binding.restoreDefaultRow')}</span>
                    </div>
                  </div>
                </>
              ) : !selected ? (
                <p style={hintStyle}>{t('providers.binding.selectProviderHint')}</p>
              ) : !selectedCompatible ? (
                <p style={hintStyle}>{t('providers.binding.needsProxy')}</p>
              ) : (
                <>
                  <div style={detailHeaderStyle}>
                    <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>
                      {t('providers.binding.modelHint')}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => stageDefault()}
                      {...hoverBackground('transparent', token('surfaceHover'))}
                      style={useDefaultStyle}
                    >
                      {t('providers.binding.useDefault')}
                    </button>
                  </div>

                  {selected.models.length > SEARCH_THRESHOLD && (
                    <input
                      value={modelQuery}
                      onChange={(e) => setModelQuery(e.target.value)}
                      placeholder={t('providers.binding.searchModels')}
                      aria-label={t('providers.binding.searchModels')}
                      style={searchStyle}
                    />
                  )}

                  <div style={modelListStyle}>
                    {filteredModels.length === 0 ? (
                      <p style={hintStyle}>{t('providers.binding.noModelMatch')}</p>
                    ) : (
                      filteredModels.map((model) => {
                        const staged = pendingModelId === model.id;
                        const bound =
                          agent.binding?.providerId === selected.id &&
                          agent.binding?.modelId === model.id;
                        return (
                          <button
                            key={model.id}
                            type="button"
                            disabled={busy}
                            onClick={() => setPendingModelId(model.id)}
                            {...hoverBackground(
                              staged ? token('accent') : 'transparent',
                              staged ? token('accent') : token('surfaceHover'),
                            )}
                            style={modelRowStyle(staged)}
                          >
                            <span
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: space.sm,
                                overflow: 'hidden',
                              }}
                            >
                              {bound && (
                                <>
                                  <span
                                    aria-hidden
                                    style={{
                                      width: 7,
                                      height: 7,
                                      borderRadius: radius.pill,
                                      background: staged ? token('accentText') : token('accent'),
                                      flexShrink: 0,
                                    }}
                                  />
                                  <span className="sr-only">{t('providers.binding.bound')}</span>
                                </>
                              )}
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {model.id}
                              </span>
                            </span>
                            {model.alias && (
                              <span
                                style={{
                                  fontSize: fontSize.xs,
                                  color: staged ? token('accentText') : token('textMuted'),
                                }}
                              >
                                → {model.alias}
                              </span>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

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
            style={closeStyle}
          >
            {t('providers.form.cancel')}
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!canApply}
            {...hoverBackground(
              isRestoreSelected ? token('danger') : token('accent'),
              isRestoreSelected ? token('dangerHover') : token('accentHover'),
            )}
            style={{
              ...applyStyle,
              border: `1px solid ${isRestoreSelected ? token('danger') : token('accent')}`,
              background: isRestoreSelected ? token('danger') : token('accent'),
              opacity: canApply ? 1 : 0.5,
              cursor: canApply ? 'pointer' : 'default',
            }}
          >
            {busy
              ? t('providers.form.saving')
              : isRestoreSelected
                ? t('providers.agent.restoreDefault')
                : t('providers.binding.apply')}
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
  width: 'min(720px, 100%)',
  maxHeight: '100%',
  overflowY: 'auto',
  background: token('bg'),
  color: token('text'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.xl,
  boxShadow: elevation('modal'),
  padding: 20,
} as const;

// Title row + a corner close affordance (mirrors ProviderFormDialog).
const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: space.md,
  marginBottom: 4,
} as const;

const closeButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
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

const panesStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(180px, 240px) 1fr',
  gap: space.lg,
  minHeight: 220,
} as const;

const providerListStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: space.xs,
  maxHeight: 360,
  overflowY: 'auto',
  borderRight: `1px solid ${token('border')}`,
  paddingRight: 8,
} as const;

function providerRowStyle(selected: boolean, compatible: boolean) {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
    width: '100%',
    textAlign: 'left',
    padding: '8px 10px',
    borderRadius: radius.md,
    border: `1px solid ${selected ? token('accent') : 'transparent'}`,
    background: selected ? token('surfaceHover') : 'transparent',
    color: token('text'),
    cursor: 'pointer',
    fontSize: fontSize.base,
    opacity: compatible ? 1 : 0.5,
  } as const;
}

// The restore-default entry: same footprint as a provider row, marked off with a
// bottom divider so it reads as a distinct, standing action above the pool.
function restoreRowStyle(selected: boolean) {
  return {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    textAlign: 'left',
    padding: '8px 10px',
    marginBottom: space.xs,
    borderRadius: radius.md,
    border: `1px solid ${selected ? token('accent') : 'transparent'}`,
    borderBottom: `1px solid ${token('border')}`,
    background: selected ? token('surfaceHover') : 'transparent',
    color: token('text'),
    cursor: 'pointer',
    fontSize: fontSize.base,
  } as const;
}

const providerNameRowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: space.sm,
} as const;

const boundDotStyle = {
  width: 8,
  height: 8,
  borderRadius: radius.pill,
  background: token('accent'),
  flexShrink: 0,
} as const;

const detailStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.md,
  minWidth: 0,
} as const;

const detailHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: space.md,
} as const;

const hintStyle = { margin: 0, fontSize: fontSize.base, color: token('textMuted') } as const;

const modelListStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.xs,
  maxHeight: 300,
  overflowY: 'auto',
} as const;

function modelRowStyle(active: boolean) {
  return {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 10,
    width: '100%',
    textAlign: 'left',
    padding: '7px 10px',
    borderRadius: radius.md,
    border: `1px solid ${active ? token('accent') : token('borderStrong')}`,
    background: active ? token('accent') : 'transparent',
    color: active ? token('accentText') : token('text'),
    cursor: 'pointer',
    fontSize: fontSize.base,
  } as const;
}

const searchStyle = {
  padding: '6px 10px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: token('surface'),
  color: token('text'),
  fontSize: fontSize.base,
} as const;

const badgeStyle = {
  fontSize: fontSize.xs,
  padding: '2px 8px',
  borderRadius: radius.pill,
  border: `1px solid ${token('border')}`,
  color: token('textMuted'),
} as const;

const useDefaultStyle = {
  padding: '4px 12px',
  borderRadius: radius.pill,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
} as const;

const closeStyle = {
  padding: '8px 16px',
  borderRadius: radius.md,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.md,
} as const;

// Primary commit button — accent fill, dimmed while disabled (nothing staged / busy).
const applyStyle = {
  padding: '8px 16px',
  borderRadius: radius.md,
  border: `1px solid ${token('accent')}`,
  background: token('accent'),
  color: token('accentText'),
  fontSize: fontSize.md,
} as const;
