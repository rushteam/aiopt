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

  // Is binding this agent the outstanding action? Only when there is something to bind TO.
  const primary = !agent.binding && providers.length > 0;

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
        {/* Only the EXCEPTION gets a badge. Installed is the normal case — on a typical
            machine it was 7 of 8 cards, so badging it spent the row's attention on the
            unremarkable and left the one not-detected agent needing to be read to be
            found. No badge now means "fine"; a badge means "look at this". */}
        {!agent.installed && (
          <span style={notInstalledBadgeStyle}>{t('providers.agent.notInstalled')}</span>
        )}
      </div>
      {/* Bound vs unbound is the card's whole point, so the two states are not the same
          weight: a binding reads at full `text`, while "not configured" stays muted. They
          were both muted 13px, which rendered the screen's most important distinction as
          its least visible one. */}
      <p style={bound ? boundStyle : metaStyle}>
        {bound
          ? `${bound.name} · ${agent.binding?.modelId ?? ''}`
          : t('providers.agent.unbound')}
      </p>

      {/* Wraps rather than compressing: with the proxy action present, three labels
          exceed the card's inner width in EVERY locale (German is ~1.8x it), and a
          flex row without this squeezes them until the text breaks mid-word. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.md }}>
        {/* The binding action is the only thing on this screen a user comes here to DO, so
            on an unconfigured agent it wears accent — and only there. It is deliberately
            self-extinguishing: configure the agent and the button drops back to a ghost,
            so the accent left on screen always counts what is still outstanding rather
            than decorating all eight cards forever.

            It stays a ghost while the pool is empty, even though nothing is bound: the
            picker would open onto "add a provider first", and pointing the eye's one
            emphasis at a dead end is worse than leaving the card quiet. In that state the
            pool's own Add button holds the accent instead. */}
        <button
          type="button"
          onClick={onChange}
          {...(primary
            ? hoverBackground(token('accent'), token('accentHover'))
            : hoverBackground('transparent', token('surfaceHover')))}
          style={primary ? primaryActionStyle : actionStyle}
        >
          {primary ? t('providers.agent.configure') : t('providers.agent.change')}
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

// The bound provider+model — the card's primary content, so full `text` weight.
const boundStyle = { margin: 0, fontSize: fontSize.base, color: token('text') } as const;

// Shown ONLY when an agent isn't detected. A pill like ProviderCard's format badge so the
// two cards speak one status language, but `textMuted` on a plain ground: it flags
// something to notice, not something wrong — the agent may simply not be installed yet.
const notInstalledBadgeStyle = {
  fontSize: fontSize.xs,
  padding: '2px 8px',
  borderRadius: radius.pill,
  border: `1px solid ${token('border')}`,
  color: token('textMuted'),
  whiteSpace: 'nowrap',
} as const;

// The card's primary action: filled accent, so it reads as "do this" at a glance rather
// than as the first of three equal ghosts. Same metrics as `actionStyle` so promoting a
// button never changes the row's height or reflows the wrap.
const primaryActionStyle = {
  padding: '5px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('accent')}`,
  background: token('accent'),
  color: token('accentText'),
  cursor: 'pointer',
  fontSize: fontSize.base,
  whiteSpace: 'nowrap',
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
