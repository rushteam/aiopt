import type { CSSProperties, ReactNode } from 'react';
import { fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import { buttonAccentChrome, buttonGhostChrome } from '../../components/ui/controlStyles';
import type { AgentSummary } from '../../../shared/ipc-channels';
export function ProvidersSetupGuide({
  poolEmpty,
  installedAgents,
  unboundInstalled,
  hiddenAgentCount,
  onAddCustom,
  onScanImport,
  onBindAgent,
  onShowHiddenAgents,
}: {
  poolEmpty: boolean;
  installedAgents: readonly AgentSummary[];
  unboundInstalled: readonly AgentSummary[];
  hiddenAgentCount: number;
  onAddCustom: () => void;
  onScanImport: () => void;
  onBindAgent: (agent: AgentSummary) => void;
  onShowHiddenAgents: () => void;
}) {
  const t = useT();

  const showStep2 = !poolEmpty;
  const noAgentsOnMachine = showStep2 && installedAgents.length === 0;

  return (
    <section style={cardStyle} aria-labelledby="providers-setup-title">
      <h2 id="providers-setup-title" style={titleStyle}>
        {t('providers.setup.title')}
      </h2>

      <div style={stepsStyle}>
        <SetupStep
          n={1}
          active={poolEmpty}
          done={!poolEmpty}
          title={t('providers.setup.step1Title')}
          hint={t('providers.setup.step1Hint')}
        >
          {poolEmpty && (
            <div style={choiceRowStyle}>
              <button
                type="button"
                onClick={onAddCustom}
                {...hoverBackground(token('accent'), token('accentHover'))}
                style={buttonAccentChrome('md')}
              >
                {t('providers.setup.customProvider')}
              </button>
              <button
                type="button"
                onClick={onScanImport}
                {...hoverBackground('transparent', token('surfaceHover'))}
                style={buttonGhostChrome('md')}
              >
                {t('providers.setup.scanAgentLogins')}
              </button>
            </div>
          )}
        </SetupStep>

        <SetupStep
          n={2}
          active={showStep2 && !noAgentsOnMachine && unboundInstalled.length > 0}
          done={!poolEmpty && unboundInstalled.length === 0 && installedAgents.length > 0}
          title={t('providers.setup.step2Title')}
          hint={
            poolEmpty
              ? t('providers.setup.step2Waiting')
              : noAgentsOnMachine
                ? t('providers.setup.noAgentsHint')
                : t('providers.setup.step2Hint')
          }
        >
          {poolEmpty ? null : noAgentsOnMachine ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space.sm, alignItems: 'flex-start' }}>
              <p style={emphasisStyle}>{t('providers.setup.noAgentsTitle')}</p>
              {hiddenAgentCount > 0 && (
                <button
                  type="button"
                  onClick={onShowHiddenAgents}
                  {...hoverBackground('transparent', token('surfaceHover'))}
                  style={buttonGhostChrome('sm')}
                >
                  {t('providers.agents.showNotDetected').replace('{{count}}', String(hiddenAgentCount))}
                </button>
              )}
            </div>
          ) : (
            <div style={choiceRowStyle}>
              {unboundInstalled.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => onBindAgent(agent)}
                  {...hoverBackground(token('accent'), token('accentHover'))}
                  style={buttonAccentChrome('md')}
                >
                  {t('providers.setup.bindAgent').replace('{{name}}', agent.name)}
                </button>
              ))}
            </div>
          )}
        </SetupStep>
      </div>
    </section>
  );
}

function SetupStep({
  n,
  active,
  done,
  title,
  hint,
  children,
}: {
  n: number;
  active: boolean;
  done: boolean;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  const badgeColor = done ? token('accent') : active ? token('accent') : token('textMuted');
  const badgeBg = done || active ? token('accent') : token('surface');
  const badgeText = done || active ? token('accentText') : token('textMuted');

  return (
    <div style={{ opacity: active || done ? 1 : 0.72 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: space.md }}>
        <span
          aria-hidden
          style={{
            ...stepBadgeStyle,
            background: done || active ? badgeColor : badgeBg,
            color: badgeText,
            border: `1px solid ${done || active ? token('accent') : token('borderStrong')}`,
          }}
        >
          {done ? '✓' : n}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: fontSize.md, fontWeight: 600, color: token('text'), marginBottom: 4 }}>{title}</div>
          <p style={{ margin: '0 0 12px', fontSize: fontSize.sm, color: token('textMuted'), lineHeight: 1.45 }}>{hint}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  marginBottom: space['2xl'],
  padding: '20px 22px',
  borderRadius: radius.lg,
  border: `1px dashed ${token('borderStrong')}`,
  background: token('surface'),
};

const titleStyle: CSSProperties = {
  margin: `0 0 ${space.lg}px`,
  fontSize: fontSize.xl,
  fontWeight: 600,
};

const stepsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.xl,
};

const choiceRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: space.md,
};

const stepBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  borderRadius: radius.pill,
  fontSize: fontSize.sm,
  fontWeight: 600,
  flexShrink: 0,
};

const emphasisStyle: CSSProperties = {
  margin: 0,
  fontSize: fontSize.sm,
  fontWeight: 600,
  color: token('text'),
};
