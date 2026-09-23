// AiOpt home — the two halves of the product in one scroll:
//   · Agents  — each target agent and the provider+model it's bound to.
//   · Providers — the global pool you enter once and reuse everywhere.
//
// State is read from the renderer provider store (mirrored from main); all writes
// go back through it. Dialogs (add/edit provider, bind agent) are local UI state.

import { useState } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import { useProviders } from '../../hooks/useProviders';
import type { AgentSummary, ProviderSummary } from '../../../shared/ipc-channels';
import { AgentCard } from './AgentCard';
import { ProxyControlBar } from './ProxyControlBar';
import { ProviderCard } from './ProviderCard';
import { BindingPicker } from './BindingPicker';
import { AgentConfigDialog } from './AgentConfigDialog';
import { ProviderFormDialog } from './ProviderFormDialog';

type Dialog =
  | { kind: 'none' }
  | { kind: 'add' }
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
  const poolEmpty = providers.length === 0;

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', padding: '24px 24px 48px' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: fontSize['3xl'] }}>{t('providers.title')}</h1>
        <p style={{ margin: '0 0 24px', color: token('textMuted'), fontSize: fontSize.md }}>
          {t('providers.subtitle')}
        </p>

        <section style={{ marginBottom: 32 }}>
          <h2 style={sectionHeadingStyle}>{t('providers.agents.heading')}</h2>
          <ProxyControlBar proxyPort={proxyPort} anyProxied={anyProxied} />
          <div style={gridStyle}>
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                providers={providers}
                onChange={() => setDialog({ kind: 'bind', agent })}
                onViewConfig={() => setDialog({ kind: 'config', agent })}
              />
            ))}
          </div>
        </section>

        <section>
          {/* The button sits NEXT TO its heading, not pushed to the far edge. `space-between`
              on an 832px content column left ~660px of empty space between the two (575px
              even in German), which is far past the distance at which a control still reads
              as belonging to the thing it acts on. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: space.lg, marginBottom: 12 }}>
            <h2 style={{ ...sectionHeadingStyle, margin: 0 }}>{t('providers.pool.heading')}</h2>
            {/* Ghost while the pool has entries: adding another provider is maintenance,
                not what a user opened this screen to do, and as the page's only filled
                accent it was drawing the eye to the bottom-right corner while every
                unconfigured agent above sat silent. It fills in only when the pool is
                EMPTY — then it genuinely is the one thing to do first, and the agent
                cards deliberately stay ghosts so this is the single emphasis on screen. */}
            <button
              type="button"
              onClick={() => setDialog({ kind: 'add' })}
              {...(poolEmpty
                ? hoverBackground(token('accent'), token('accentHover'))
                : hoverBackground('transparent', token('surfaceHover')))}
              style={poolEmpty ? addPrimaryStyle : addGhostStyle}
            >
              {t('providers.addProvider')}
            </button>
          </div>
          {providers.length === 0 ? (
            <p style={{ fontSize: fontSize.md, color: token('textMuted') }}>{t('providers.pool.empty')}</p>
          ) : (
            <div style={gridStyle}>
              {providers.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  onEdit={() => setDialog({ kind: 'edit', provider })}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {dialog.kind === 'add' && <ProviderFormDialog onClose={close} />}
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
    </div>
  );
}

const sectionHeadingStyle = { margin: '0 0 12px', fontSize: fontSize.xl } as const;

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
