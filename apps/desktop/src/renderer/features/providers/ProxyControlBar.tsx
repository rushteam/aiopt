// Proxy mode lives HERE, at the top of the Agents section, rather than in Settings —
// it's a provider-routing decision, so it belongs next to the bindings it governs and
// the address it exposes. One unit: the on/off switch, and (once relevant) the live
// proxy status + loopback address.
//
// Two axes decide what shows, and they are NOT the same thing:
//   • proxyMode (a stored preference) — when ON, same-format bindings are also routed
//     through the proxy so their usage is counted; when OFF (default) they connect
//     directly. This is what the switch toggles.
//   • whether the proxy is ACTUALLY serving traffic — cross-format bindings always route
//     through the proxy regardless of the switch, so the server can be running (and an
//     address worth showing) even with the switch off.
// So the address/status row shows when the switch is on OR any binding is actually
// proxied; and it reflects the REAL server state (green + address / red "not running"),
// never merely the switch position.

import { useEffect, useState } from 'react';
import { token, fontSize, space } from '../../themes/tokens';
import { useT } from '../../i18n';
import { ProxyStatusBar } from './ProxyStatusBar';

export function ProxyControlBar({
  proxyPort,
  anyProxied,
}: {
  /** Live loopback port, or null when the proxy isn't running. */
  proxyPort: number | null;
  /** True when at least one binding is currently routed through the proxy. */
  anyProxied: boolean;
}) {
  const t = useT();
  const [proxyMode, setProxyMode] = useState<boolean | null>(null);

  // Load proxy-mode, then track cross-window changes (the same value the old Settings
  // control drove; only the UI location moved — the preference still lives in main).
  useEffect(() => {
    let alive = true;
    void window.aiopt.config.getAll().then((prefs) => {
      if (alive) setProxyMode(prefs.proxyMode);
    });
    const off = window.aiopt.config.onChanged((prefs) => setProxyMode(prefs.proxyMode));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const enabled = proxyMode === true;
  const loading = proxyMode === null;

  const toggle = (): void => {
    if (loading) return;
    const next = !proxyMode;
    setProxyMode(next); // optimistic; the config:changed echo confirms
    void window.aiopt.config.set('proxyMode', next);
  };

  // The address/status row is meaningful when the switch is on, or when a cross-format
  // binding is routing through the proxy anyway (server up, address worth showing).
  const showStatus = enabled || anyProxied;

  return (
    <div style={barStyle}>
      <div>
        {/* The switch is paired with the label LINE, and the help text sits underneath it
            rather than beside it. Putting the two in one row with the paragraph did not
            work: the paragraph's max-content width is wider than the 832px column, so the
            label block stretched to fill and pushed the switch ~700px away from the words
            naming it — the control and its label read as unrelated. */}
        <div style={rowStyle}>
          <div style={{ fontSize: fontSize.md, fontWeight: 600 }}>{t('general.proxyMode.label')}</div>

          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={t('general.proxyMode.label')}
            disabled={loading}
            onClick={toggle}
            style={{
              flexShrink: 0,
              position: 'relative',
              width: 44,
              height: 24,
              borderRadius: 999,
              border: 'none',
              cursor: loading ? 'default' : 'pointer',
              background: enabled ? token('accent') : token('borderStrong'),
              opacity: loading ? 0.5 : 1,
              transition: 'background 120ms ease',
              padding: 0,
            }}
          >
            <span
              aria-hidden
              style={{
                position: 'absolute',
                top: 2,
                left: enabled ? 22 : 2,
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: token('bg'),
                transition: 'left 120ms ease',
              }}
            />
          </button>
        </div>

        <p style={helpStyle}>{t('general.proxyMode.help')}</p>
      </div>

      {/* ProxyStatusBar carries its own 12px bottom margin for callers that stack it
          directly; here this region supplies its own spacing below the hairline, so cancel
          it rather than let it double up. */}
      {showStatus && (
        <div style={{ marginBottom: -space.lg }}>
          <ProxyStatusBar port={proxyPort} />
        </div>
      )}
    </div>
  );
}

// This bar GOVERNS the grid below it, but it used to read as the grid's first card: same
// `surface` fill, same `border`, radius 8 vs the cards' 10 (2px — not perceptible), and a
// 12px gap below it identical to the grid's own row gap. Four cues said "sibling" and none
// said "governs".
//
// So it stops being a card: no fill, no box, just a hairline underneath and the page
// background showing through. That reads as a rule over a region rather than an object
// inside it — and it's why the fill/border matching the cards was the problem, not the
// radius. The gap below is also widened past the grid's 12px row gap, so the distance to
// the first card no longer equals the distance between two card rows.
const barStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.lg,
  paddingBottom: space.lg,
  // 24px below the hairline, deliberately DOUBLE the grid's 12px row gap: the old 12px
  // made the distance from this bar to the first card identical to the distance between
  // two card rows, which is one of the four cues that made it read as a grid item.
  marginBottom: space['2xl'],
  borderBottom: `1px solid ${token('border')}`,
} as const;

// Label + switch, both sized to their content and 12px apart — no `space-between`, so the
// row does not spread to the column's full width.
const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: space.lg,
} as const;

const helpStyle = {
  margin: '4px 0 0',
  color: token('textMuted'),
  fontSize: fontSize.base,
  lineHeight: 1.5,
} as const;
