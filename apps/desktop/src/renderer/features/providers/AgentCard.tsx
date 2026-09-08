// One target agent: name, install status, and its current provider+model binding,
// with a single action that opens the binding picker.
//
// "Restore default" is no longer a button on the card — it now lives inside the picker
// as a selectable "system default" entry (pick it, Apply, and AiOpt hands the config
// back). So the card itself carries no destructive action.

import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import type { AgentSummary, ProviderSummary } from '../../../shared/ipc-channels';

export function AgentCard({
  agent,
  providers,
  onChange,
}: {
  agent: AgentSummary;
  providers: ProviderSummary[];
  onChange: () => void;
}) {
  const t = useT();

  const bound = agent.binding
    ? providers.find((p) => p.id === agent.binding?.providerId)
    : undefined;

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.md }}>
        <strong style={{ fontSize: fontSize.lg }}>{agent.name}</strong>
        <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>
          {agent.installed ? t('providers.agent.installed') : t('providers.agent.notInstalled')}
        </span>
      </div>
      <p style={metaStyle}>
        {bound
          ? `${bound.name} · ${agent.binding?.modelId ?? ''}`
          : t('providers.agent.unbound')}
      </p>

      <div style={{ display: 'flex', gap: space.md }}>
        <button
          type="button"
          onClick={onChange}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={actionStyle}
        >
          {t('providers.agent.change')}
        </button>
      </div>
    </div>
  );
}

const cardStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.sm,
  padding: 14,
  borderRadius: radius.lg,
  border: `1px solid ${token('border')}`,
  background: token('surface'),
} as const;

const metaStyle = { margin: 0, fontSize: fontSize.base, color: token('textMuted') } as const;

const actionStyle = {
  padding: '5px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('border')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.base,
} as const;
