// AiOpt home — the two halves of the product in one scroll:
//   · Agents  — each target agent and the provider+model it's bound to.
//   · Providers — the global pool you enter once and reuse everywhere.
//
// State is read from the renderer provider store (mirrored from main); all writes
// go back through it. Dialogs (add/edit provider, bind agent) are local UI state.

import { useMemo, useState } from 'react';
import { isCombinedProviderId } from '../../../shared/combinedProvider';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT, type TranslateFn } from '../../i18n';
import { useProviders } from '../../hooks/useProviders';
import type { AgentSummary, ProviderSummary } from '../../../shared/ipc-channels';
import { AgentCard } from './AgentCard';
import { ProxyControlBar } from './ProxyControlBar';
import { ProviderCard } from './ProviderCard';
import { BindingPicker } from './BindingPicker';
import { AgentConfigDialog } from './AgentConfigDialog';
import { ProviderFormDialog } from './ProviderFormDialog';
import { ScrollTabScreen, tabScreenIntroStyle, tabScreenSectionStyle } from '../../components/TabScreenShell';
import { BindingProfileSwitcher } from './BindingProfileSwitcher';
import { AgentImportDialog } from './AgentImportDialog';
import { ProvidersSetupGuide } from './ProvidersSetupGuide';
import { shouldShowProvidersSetupGuide } from './providersSetupState';

type Dialog =
  | { kind: 'none' }
  | { kind: 'add' }
  | { kind: 'import' }
  | { kind: 'edit'; provider: ProviderSummary }
  | { kind: 'bind'; agent: AgentSummary }
  | { kind: 'config'; agent: AgentSummary };

export function ProvidersHome() {
  const t = useT();
  const { providers, agents, proxyPort } = useProviders();
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const close = () => setDialog({ kind: 'none' });

  // Proxy mode is a routing decision, so its control lives here at the top of the Agents
  // section rather than in Settings. The control ALWAYS renders (it's the on/off switch);
  // its inner status/address row appears when the switch is on OR any binding is actually
  // proxied. `anyProxied` covers cross-format bindings, which route through the proxy even
  // with the switch off — that failure/liveness is exactly what a user needs to SEE.
  // `proxyPort !== null` reflects the live server (port and server are set/cleared together
  // in translationProxy), so it drives the running indicator inside the bar.
  const anyProxied = agents.some((a) => a.proxied);

  // An empty pool is the one state where adding a provider IS the outstanding action —
  // nothing can be bound until it happens. It's also what keeps the two emphasis rules
  // from fighting: AgentCard leaves its button a ghost while the pool is empty, so
  // exactly one filled accent is ever on this screen.
  const realProviders = useMemo(
    () => providers.filter((p) => !isCombinedProviderId(p.id)),
    [providers],
  );
  const poolEmpty = realProviders.length === 0;

  const installedAgents = useMemo(() => agents.filter((a) => a.installed), [agents]);
  const hiddenAgents = useMemo(() => agents.filter((a) => !a.installed), [agents]);
  const unboundInstalled = useMemo(
    () => installedAgents.filter((a) => !a.binding),
    [installedAgents],
  );
  const [showHiddenAgents, setShowHiddenAgents] = useState(false);

  const showSetupGuide = shouldShowProvidersSetupGuide({ poolEmpty });

  return (
    <>
      <ScrollTabScreen>
        {/* The tab above already names this screen, and repeating it ~60px lower said the
            word twice and spent 47px of vertical space to do it. The h1 stays in the DOM
            but visually hidden: it is the document's only top-level heading, so removing
            it outright would leave the page a set of h2s with nothing above them, and a
            screen reader announcing the region would lose the screen's name. */}
        <h1 className="sr-only">{t('providers.title')}</h1>
        {/* Page-level: intro + binding profile (not tied to the Agent section below). */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: space.lg,
            marginBottom: space['2xl'],
            flexWrap: 'wrap',
          }}
        >
          <p
            style={{
              ...tabScreenIntroStyle,
              margin: 0,
              flex: '1 1 240px',
              minWidth: 0,
              color: token('textMuted'),
              fontSize: fontSize.md,
            }}
          >
            {t('providers.subtitle')}
          </p>
          <BindingProfileSwitcher />
        </div>

        {showSetupGuide && (
          <ProvidersSetupGuide
            poolEmpty={poolEmpty}
            installedAgents={installedAgents}
            unboundInstalled={unboundInstalled}
            hiddenAgentCount={hiddenAgents.length}
            onAddCustom={() => setDialog({ kind: 'add' })}
            onScanImport={() => setDialog({ kind: 'import' })}
            onBindAgent={(agent) => setDialog({ kind: 'bind', agent })}
            onShowHiddenAgents={() => setShowHiddenAgents(true)}
          />
        )}

        {poolEmpty && (
          <section style={tabScreenSectionStyle}>
            <PoolSection
              t={t}
              poolEmpty={poolEmpty}
              realProviders={realProviders}
              hideHeaderActions={showSetupGuide}
              onAdd={() => setDialog({ kind: 'add' })}
              onImport={() => setDialog({ kind: 'import' })}
            />
          </section>
        )}

        <section style={tabScreenSectionStyle}>
          <h2 style={sectionHeadingStyle}>{t('providers.agents.heading')}</h2>
          <ProxyControlBar proxyPort={proxyPort} anyProxied={anyProxied} />
          {poolEmpty && installedAgents.length === 0 && (
            <p style={{ margin: '0 0 12px', fontSize: fontSize.sm, color: token('textMuted') }}>
              {t('providers.agents.waitingForProvider')}
            </p>
          )}
          {installedAgents.length === 0 && !poolEmpty && (
            <p style={{ margin: '0 0 12px', fontSize: fontSize.sm, color: token('textMuted') }}>
              {t('providers.agents.emptyInstalled')}
            </p>
          )}
          <div style={gridStyle}>
            {installedAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                providers={providers}
                onChange={() => setDialog({ kind: 'bind', agent })}
                onViewConfig={() => setDialog({ kind: 'config', agent })}
              />
            ))}
          </div>
          {hiddenAgents.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() => setShowHiddenAgents((v) => !v)}
                {...hoverBackground('transparent', token('surfaceHover'))}
                style={{
                  padding: '4px 10px',
                  borderRadius: radius.sm,
                  border: `1px solid ${token('borderStrong')}`,
                  background: 'transparent',
                  color: token('textMuted'),
                  cursor: 'pointer',
                  fontSize: fontSize.sm,
                }}
              >
                {showHiddenAgents
                  ? t('providers.agents.hideNotDetected')
                  : t('providers.agents.showNotDetected').replace(
                      '{{count}}',
                      String(hiddenAgents.length),
                    )}
              </button>
              {showHiddenAgents && (
                <div style={{ ...gridStyle, marginTop: 12, opacity: 0.92 }}>
                  {hiddenAgents.map((agent) => (
                    <AgentCard
                      key={agent.id}
                      agent={agent}
                      providers={providers}
                      onChange={() => setDialog({ kind: 'bind', agent })}
                      onViewConfig={() => setDialog({ kind: 'config', agent })}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {!poolEmpty && (
          <section>
            <PoolSection
              t={t}
              poolEmpty={poolEmpty}
              realProviders={realProviders}
              hideHeaderActions={false}
              onAdd={() => setDialog({ kind: 'add' })}
              onImport={() => setDialog({ kind: 'import' })}
              onEdit={(provider) => setDialog({ kind: 'edit', provider })}
            />
          </section>
        )}
      </ScrollTabScreen>

      {dialog.kind === 'add' && <ProviderFormDialog onClose={close} />}
      {dialog.kind === 'import' && <AgentImportDialog onClose={close} />}
      {dialog.kind === 'edit' && <ProviderFormDialog provider={dialog.provider} onClose={close} />}
      {dialog.kind === 'bind' && (
        <BindingPicker agent={dialog.agent} providers={providers} onClose={close} />
      )}
      {/* Re-read from the live snapshot, not the captured agent: the dialog shows which
          files exist, and a providersChanged push (a binding write, say) must reach it. */}
      {dialog.kind === 'config' && (
        <AgentConfigDialog
          agent={agents.find((a) => a.id === dialog.agent.id) ?? dialog.agent}
          onClose={close}
        />
      )}
    </>
  );
}

// 18px, not the 16px it was. A section heading has to outrank the card titles beneath it,
// and at 16px against a bold 15px card name the ratio was 1.07x — below any usable step,
// while the eight bold card titles out-shouted the one heading by sheer repetition. 18px
// against 15px is 1.20x, and the explicit 600 keeps it ahead of `<strong>` card names.
function PoolSection({
  t,
  poolEmpty,
  realProviders,
  hideHeaderActions,
  onAdd,
  onImport,
  onEdit,
}: {
  t: TranslateFn;
  poolEmpty: boolean;
  realProviders: ProviderSummary[];
  hideHeaderActions: boolean;
  onAdd: () => void;
  onImport: () => void;
  onEdit?: (provider: ProviderSummary) => void;
}) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.lg, marginBottom: 12 }}>
        <h2 style={{ ...sectionHeadingStyle, margin: 0 }}>{t('providers.pool.heading')}</h2>
        {!hideHeaderActions && (
          <>
            <button
              type="button"
              onClick={onAdd}
              {...(poolEmpty
                ? hoverBackground(token('accent'), token('accentHover'))
                : hoverBackground('transparent', token('surfaceHover')))}
              style={poolEmpty ? addPrimaryStyle : addGhostStyle}
            >
              {t('providers.addProvider')}
            </button>
            <button
              type="button"
              onClick={onImport}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={addGhostStyle}
            >
              {t('providers.import.scanAction')}
            </button>
          </>
        )}
      </div>
      {realProviders.length === 0 ? (
        <p style={{ fontSize: fontSize.md, color: token('textMuted'), margin: 0 }}>{t('providers.pool.empty')}</p>
      ) : (
        <div style={gridStyle}>
          {realProviders.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              onEdit={() => onEdit?.(provider)}
            />
          ))}
        </div>
      )}
    </>
  );
}

const sectionHeadingStyle = {
  margin: '0 0 12px',
  fontSize: fontSize['2xl'],
  fontWeight: 600,
} as const;

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
  gap: space.lg,
} as const;

// Shared metrics so the button doesn't resize when the pool goes from empty to filled.
// Deliberately the same metrics as AgentCard's action buttons (5px/12px, 13px, radius.sm)
// rather than the larger 8px/16px/14px it used to have: one ghost-button size across the
// screen, and a secondary action shouldn't be the biggest control on the page.
const addBase = {
  padding: '5px 12px',
  borderRadius: radius.sm,
  cursor: 'pointer',
  fontSize: fontSize.base,
} as const;

const addPrimaryStyle = {
  ...addBase,
  border: `1px solid ${token('accent')}`,
  background: token('accent'),
  color: token('accentText'),
} as const;

const addGhostStyle = {
  ...addBase,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
} as const;
