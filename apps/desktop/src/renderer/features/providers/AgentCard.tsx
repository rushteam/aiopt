// One target agent: name, install status, and its current provider+model binding,
// with a single action that opens the binding picker.
//
// "Restore default" is no longer a button on the card — it now lives inside the picker
// as a selectable "system default" entry (pick it, Apply, and AiOpt hands the config
// back). So the card itself carries no destructive action.
//
// "View config" opens a read-only modal (AgentConfigDialog) describing what AiOpt manages
// for this agent. Like the binding picker, the dialog is the PARENT's state — the card only
// asks for it — so the grid never has two panels fighting for the same space.

import { useEffect, useRef, useState } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import { copyProxyConfig } from '../../lib/providerStore';
import type { AgentSummary, ProviderSummary } from '../../../shared/ipc-channels';

export function AgentCard({
  agent,
  providers,
  onChange,
  onViewConfig,
}: {
  agent: AgentSummary;
  providers: ProviderSummary[];
  onChange: () => void;
  /** Open the read-only config dialog for this agent. */
  onViewConfig: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the pending "Copied" reset on unmount so it never fires on a gone component.
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const bound = agent.binding
    ? providers.find((p) => p.id === agent.binding?.providerId)
    : undefined;

  async function onCopyProxyConfig(): Promise<void> {
    const ok = await copyProxyConfig(agent.id);
    if (!ok) return; // route vanished (raced a binding change) — leave the label unchanged
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.md }}>
        <strong style={{ fontSize: fontSize.lg }}>{agent.name}</strong>
        <span style={{ ...statusBadgeStyle, color: agent.installed ? token('text') : token('textMuted') }}>
          {agent.installed ? t('providers.agent.installed') : t('providers.agent.notInstalled')}
        </span>
      </div>
      <p style={metaStyle}>
        {bound
          ? `${bound.name} · ${agent.binding?.modelId ?? ''}`
          : t('providers.agent.unbound')}
      </p>

      {/* Wraps rather than compressing: with the proxy action present, three labels
          exceed the card's inner width in EVERY locale (German is ~1.8x it), and a
          flex row without this squeezes them until the text breaks mid-word. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.md }}>
        <button
          type="button"
          onClick={onChange}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={actionStyle}
        >
          {t('providers.agent.change')}
        </button>
        <button
          type="button"
          onClick={onViewConfig}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={actionStyle}
        >
          {t('providers.agent.viewConfig')}
        </button>
        {agent.proxied && (
          <button
            type="button"
            onClick={() => void onCopyProxyConfig()}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={actionStyle}
          >
            {copied ? t('providers.agent.copied') : t('providers.agent.copyProxyConfig')}
          </button>
        )}
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

// Install status as a pill, matching ProviderCard's format badge so both cards in the
// Agents grid speak one status language. Color (not shape) carries the meaning: installed
// reads at full `text`, not-detected recedes to `textMuted`.
const statusBadgeStyle = {
  fontSize: fontSize.xs,
  padding: '2px 8px',
  borderRadius: radius.pill,
  border: `1px solid ${token('border')}`,
} as const;

const actionStyle = {
  padding: '5px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.base,
  // Keep each label on one line: wrapping moves a whole button to the next row,
  // which is the intent — a button that breaks its own text mid-word is not.
  whiteSpace: 'nowrap',
} as const;
