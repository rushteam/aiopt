// The local translation proxy's shared identity: a live/stopped status dot, the loopback
// port every proxied agent is currently routed through, plus a manual "refresh port" action.
//
// The port is ONE address shared by all proxied bindings (not a per-agent property), so it
// lives here at the top of the Agents section rather than on any AgentCard. Refreshing moves
// the proxy to a fresh port and re-syncs every proxied agent's on-disk config in one step —
// the escape hatch when the persisted port collides with another process.
//
// `port` is null when the proxy is NOT running (failed to bind / stopped) while a binding
// still expects it — the caller renders this bar precisely so that failure is visible rather
// than silent. In that state the dot is red, the address reads "not running", and refresh is
// disabled (there's nothing bound to move). The port and the underlying server are set and
// cleared together main-side, so a non-null port means the server is genuinely listening.

import { useEffect, useRef, useState } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import { refreshProxyPort } from '../../lib/providerStore';

export function ProxyStatusBar({ port }: { port: number | null }) {
  const t = useT();
  const running = port !== null;
  const [busy, setBusy] = useState(false);
  // Brief post-action confirmation. Refreshing rewrites every proxied agent's on-disk
  // config, so it earns an explicit acknowledgement — mirroring AgentCard's "copied"
  // idiom — rather than letting only the (small, monospace) port number quietly change.
  const [refreshed, setRefreshed] = useState(false);
  const refreshedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the pending "refreshed" reset on unmount so it never fires on a gone component.
  useEffect(() => () => {
    if (refreshedTimer.current) clearTimeout(refreshedTimer.current);
  }, []);

  async function onRefresh(): Promise<void> {
    if (busy || !running) return;
    setBusy(true);
    try {
      // The fresh port arrives via the providers:changed push, so we don't apply it here;
      // just release the button when the round-trip settles.
      await refreshProxyPort();
      setRefreshed(true);
      if (refreshedTimer.current) clearTimeout(refreshedTimer.current);
      refreshedTimer.current = setTimeout(() => setRefreshed(false), 1500);
    } finally {
      setBusy(false);
    }
  }

  const label = busy
    ? t('providers.proxy.refreshing')
    : refreshed
      ? t('providers.proxy.refreshed')
      : t('providers.proxy.refresh');

  const disabled = busy || !running;

  return (
    <div style={barStyle}>
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          flexShrink: 0,
          background: running ? token('success') : token('danger'),
        }}
      />
      <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>
        {t('providers.proxy.label')}
      </span>
      {running ? (
        <code style={addressStyle}>127.0.0.1:{port}</code>
      ) : (
        <span style={{ fontSize: fontSize.base, color: token('danger') }}>
          {t('providers.proxy.stopped')}
        </span>
      )}
      <span style={{ flex: 1 }} />
      <button
        type="button"
        onClick={() => void onRefresh()}
        disabled={disabled}
        {...hoverBackground('transparent', token('surfaceHover'))}
        style={{ ...refreshStyle, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}
      >
        {label}
      </button>
    </div>
  );
}

const barStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: space.md,
  padding: '8px 12px',
  marginBottom: space.lg,
  borderRadius: radius.md,
  border: `1px solid ${token('border')}`,
  background: token('surface'),
} as const;

const addressStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: fontSize.base,
  color: token('text'),
} as const;

const refreshStyle = {
  padding: '5px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('border')}`,
  background: 'transparent',
  color: token('text'),
  fontSize: fontSize.base,
} as const;
