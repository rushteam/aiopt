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
import { ProviderCard } from './ProviderCard';
import { BindingPicker } from './BindingPicker';
import { ProviderFormDialog } from './ProviderFormDialog';

type Dialog =
  | { kind: 'none' }
  | { kind: 'add' }
  | { kind: 'edit'; provider: ProviderSummary }
  | { kind: 'bind'; agent: AgentSummary };

export function ProvidersHome() {
  const t = useT();
  const { providers, agents } = useProviders();
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const close = () => setDialog({ kind: 'none' });

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', padding: '24px 24px 48px' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: fontSize['3xl'] }}>{t('providers.title')}</h1>
        <p style={{ margin: '0 0 24px', color: token('textMuted'), fontSize: fontSize.md }}>
          {t('providers.subtitle')}
        </p>

        <section style={{ marginBottom: 32 }}>
          <h2 style={sectionHeadingStyle}>{t('providers.agents.heading')}</h2>
          <div style={gridStyle}>
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                providers={providers}
                onChange={() => setDialog({ kind: 'bind', agent })}
              />
            ))}
          </div>
        </section>

        <section>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ ...sectionHeadingStyle, margin: 0 }}>{t('providers.pool.heading')}</h2>
            <button
              type="button"
              onClick={() => setDialog({ kind: 'add' })}
              {...hoverBackground(token('accent'), token('accentHover'))}
              style={addStyle}
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
    </div>
  );
}

const sectionHeadingStyle = { margin: '0 0 12px', fontSize: fontSize.xl } as const;

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
  gap: space.lg,
} as const;

const addStyle = {
  padding: '8px 16px',
  borderRadius: radius.md,
  border: `1px solid ${token('accent')}`,
  background: token('accent'),
  color: token('accentText'),
  cursor: 'pointer',
  fontSize: fontSize.md,
} as const;
