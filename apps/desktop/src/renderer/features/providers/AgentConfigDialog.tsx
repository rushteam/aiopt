// One agent's config surface as a READ-ONLY modal: where its config lives, how AiOpt
// writes it, the route its requests take today, and which of its managed files exist.
//
// It shows STRUCTURE, never file contents. Several managed files hold a plaintext API key
// (codex/auth.json, gemini/.env, dsh/.credentials.yaml), and credentials-and-local-storage.md
// §1 forbids a secret transiting the preload or the renderer — a redactor that misses one
// field leaks a key, so the content simply never crosses. Raw viewing is the OS's job:
// "Reveal in file manager" hands the file over, named by (agentId, role) rather than by path,
// so main resolves it through its own allowlist and the renderer cannot forge a target.
//
// The overlay / panel / Escape / backdrop-click idiom mirrors ConfirmDialog and BindingPicker
// so the app keeps one dialog look. Nothing here writes, so there is no busy state and no
// commit button — the footer closes, and that is the only way out besides Escape.

import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { elevation, token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import { revealAgentConfig } from '../../lib/providerStore';
import type { AgentConfigFile, AgentSummary } from '../../../shared/ipc-channels';

export function AgentConfigDialog({
  agent,
  onClose,
}: {
  agent: AgentSummary;
  onClose: () => void;
}) {
  const t = useT();

  // Escape closes, matching the backdrop click. Registered while mounted only. No `busy`
  // guard to honour here (unlike ConfirmDialog) — this dialog never has a write in flight.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  // Route as the panel states it: what this agent's requests actually do today. `proxied`
  // is main's answer (a live route exists), so this only has to pick the wording.
  const routeKey = !agent.binding ? 'unbound' : agent.proxied ? 'proxied' : 'direct';

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" onClick={onClose}>
      {/* A click inside the panel is swallowed so it never bubbles to the backdrop. */}
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: fontSize.xl }}>
            {t('providers.agent.configView.title')}: {agent.name}
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

        <div style={rowsStyle}>
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
        </div>

        <div style={filesStyle}>
          <span style={labelStyle}>{t('providers.agent.configView.files')}</span>
          {agent.configFiles.length === 0 ? (
            <span style={hintStyle}>{t('providers.agent.configView.noFiles')}</span>
          ) : (
            agent.configFiles.map((file) => (
              <ConfigFileRow key={file.role} agentId={agent.id} file={file} />
            ))
          )}
        </div>

        <p style={{ ...hintStyle, margin: 0 }}>{t('providers.agent.configView.rawHint')}</p>

        <div style={actionsStyle}>
          <button
            type="button"
            onClick={onClose}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={ghostStyle}
          >
            {t('providers.form.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One label + value line. Label recedes; the value reads at full text. */
function ConfigRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: space.md, alignItems: 'baseline' }}>
      {/* minWidth, not a fixed width: the rows share a value edge in most locales, and a
          long label (German "Konfigurationsverzeichnis") pushes it out rather than wrapping. */}
      <span style={{ ...labelStyle, flex: '0 0 auto', minWidth: 132 }}>{label}</span>
      <span style={{ fontSize: fontSize.base, color: token('text'), minWidth: 0 }}>{children}</span>
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
    <div style={fileRowStyle}>
      <code style={{ ...pathStyle, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {file.displayPath}
      </code>
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
        <span style={{ ...hintStyle, flexShrink: 0 }}>
          {t('providers.agent.configView.fileMissing')}
        </span>
      )}
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: token('overlay'),
  display: 'grid',
  placeItems: 'center',
  padding: space['2xl'],
  zIndex: 20,
};

const panelStyle: CSSProperties = {
  width: 'min(560px, 100%)',
  maxHeight: '100%',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: space.lg,
  background: token('bg'),
  color: token('text'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.xl,
  boxShadow: elevation('modal'),
  padding: 20,
};

// Title row + a corner close affordance (mirrors BindingPicker / ProviderFormDialog).
const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: space.md,
};

const closeButtonStyle: CSSProperties = {
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
};

const rowsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.sm,
};

// The file list is set apart by a top rule: the rows above describe the agent, the rows
// below are the individual files, and one border says that without a nested box.
const filesStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.xs,
  paddingTop: space.sm,
  borderTop: `1px solid ${token('border')}`,
};

const fileRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: space.md,
};

const labelStyle: CSSProperties = { fontSize: fontSize.sm, color: token('textMuted') };

// Monospace for on-disk paths, matching ProxyStatusBar's address: a path is a literal, and
// a proportional font makes `~/.config/opencode` harder to read back against the real thing.
const pathStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: fontSize.sm,
  color: token('text'),
  whiteSpace: 'nowrap',
};

const hintStyle: CSSProperties = { fontSize: fontSize.sm, color: token('textMuted') };

const actionsStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: space.md,
};

const ghostStyle: CSSProperties = {
  padding: '6px 14px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.base,
};

const revealStyle: CSSProperties = {
  flexShrink: 0,
  padding: '1px 8px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.xs,
};
