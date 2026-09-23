// One target agent: name, install status, and its current provider+model binding,
// with a single action that opens the binding picker.
//
// "Restore default" is no longer a button on the card — it now lives inside the picker
// as a selectable "system default" entry (pick it, Apply, and AiOpt hands the config
// back). So the card itself carries no destructive action.
//
// "View config" expands a READ-ONLY panel describing what AiOpt manages for this agent:
// where the config lives, how it is written, and which of its managed files exist. It shows
// STRUCTURE, never file contents — several of those files hold a plaintext API key, which
// must not cross into the renderer (credentials-and-local-storage.md §1). Raw content is the
// OS's job: "Reveal in file manager" hands the file to the file manager, and the renderer
// names it by role rather than by path, so main resolves it through its own allowlist.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import { copyProxyConfig, revealAgentConfig } from '../../lib/providerStore';
import type { AgentConfigFile, AgentSummary, ProviderSummary } from '../../../shared/ipc-channels';

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
  const [copied, setCopied] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
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

  // Route as the config panel states it: what this agent's requests actually do today.
  // `proxied` is main's answer (a live route exists), so this only has to pick the wording.
  const routeKey = !agent.binding ? 'unbound' : agent.proxied ? 'proxied' : 'direct';

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

      <div style={{ display: 'flex', gap: space.md }}>
        <button
          type="button"
          onClick={onChange}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={actionStyle}
        >
          {t('providers.agent.change')}
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
        <button
          type="button"
          onClick={() => setShowConfig((open) => !open)}
          aria-expanded={showConfig}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={actionStyle}
        >
          {showConfig ? t('providers.agent.hideConfig') : t('providers.agent.viewConfig')}
        </button>
      </div>

      {showConfig && (
        <div style={panelStyle}>
          <ConfigRow label={t('providers.agent.configView.installDir')}>
            <code style={pathStyle}>{agent.installDirDisplay}</code>
          </ConfigRow>
          <ConfigRow label={t('providers.agent.configView.apiFormat')}>
            {agent.acceptedFormats.map((format) => t(`providers.formats.${format}`)).join(' · ')}
          </ConfigRow>
          <ConfigRow label={t('providers.agent.configView.mode')}>
            {t(`providers.agent.configView.modes.${agent.mode}`)}
          </ConfigRow>
          <ConfigRow label={t('providers.agent.configView.route')}>
            {t(`providers.agent.configView.routes.${routeKey}`)}
          </ConfigRow>

          <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs }}>
            <span style={labelStyle}>{t('providers.agent.configView.files')}</span>
            {agent.configFiles.length === 0 ? (
              <span style={metaStyle}>{t('providers.agent.configView.noFiles')}</span>
            ) : (
              agent.configFiles.map((file) => (
                <ConfigFileRow key={file.role} agentId={agent.id} file={file} />
              ))
            )}
          </div>

          <p style={hintStyle}>{t('providers.agent.configView.rawHint')}</p>
        </div>
      )}
    </div>
  );
}

/** One label + value line of the config panel. Label recedes; the value reads at full text. */
function ConfigRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: space.md, alignItems: 'baseline' }}>
      {/* minWidth, not a fixed width: the rows share a value edge in most locales, and a
          long label (German "Konfigurationsverzeichnis") pushes it out rather than wrapping. */}
      <span style={{ ...labelStyle, flex: '0 0 auto', minWidth: 116 }}>{label}</span>
      <span style={{ fontSize: fontSize.base, color: token('text') }}>{children}</span>
    </div>
  );
}

/**
 * One managed file: its display path, whether it exists, and a reveal action. Reveal is
 * named by (agentId, role) — the `displayPath` shown here is never sent back, so a hostile
 * renderer cannot turn this row into "open an arbitrary file". A missing file has nothing
 * to reveal, so the action is omitted rather than shown disabled.
 */
function ConfigFileRow({ agentId, file }: { agentId: AgentSummary['id']; file: AgentConfigFile }) {
  const t = useT();
  return (
    <div style={{ display: 'flex', gap: space.md, alignItems: 'baseline' }}>
      <code style={pathStyle}>{file.displayPath}</code>
      {file.exists ? (
        <button
          type="button"
          onClick={() => void revealAgentConfig(agentId, file.role)}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={revealStyle}
        >
          {t('providers.agent.configView.reveal')}
        </button>
      ) : (
        <span style={metaStyle}>{t('providers.agent.configView.fileMissing')}</span>
      )}
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

// The expanded panel sits inside the card, set apart by a top rule rather than a nested
// box — one border is enough to say "detail of the card above" without a card-in-a-card.
const panelStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.sm,
  paddingTop: space.sm,
  borderTop: `1px solid ${token('border')}`,
} as const;

const labelStyle = { fontSize: fontSize.sm, color: token('textMuted') } as const;

// Monospace for on-disk paths, matching ProxyStatusBar's address: a path is a literal, and
// a proportional font makes `~/.config/opencode` harder to read back against the real thing.
const pathStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: fontSize.sm,
  color: token('text'),
} as const;

const hintStyle = { margin: 0, fontSize: fontSize.sm, color: token('textMuted') } as const;

const revealStyle = {
  padding: '1px 8px',
  borderRadius: radius.sm,
  border: `1px solid ${token('border')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.xs,
} as const;

const actionStyle = {
  padding: '5px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('border')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.base,
} as const;
