// General settings — app-wide appearance.
//
//   • Appearance — the theme control (system / light / dark). Writes go through
//     the theme provider (→ config.set), so the choice persists and every window
//     updates via the config:changed push.
//
// Proxy mode used to live here too, but it's a provider-ROUTING decision, so its
// control now sits at the top of the Providers page (ProxyControlBar), next to the
// bindings it governs and the loopback address it exposes.

import type { ThemePreference } from '../../../shared/ipc-channels';
import { useTheme } from '../../themes/ThemeProvider';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';

const THEME_OPTIONS: ThemePreference[] = ['system', 'light', 'dark'];

export function GeneralSection() {
  const t = useT();
  const { preference, setPreference } = useTheme();

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: space['2xl'] }}>
      <div>
        <h2 style={{ margin: '0 0 4px', fontSize: fontSize['2xl'] }}>{t('appearance.title')}</h2>
        <p style={{ margin: '0 0 16px', color: token('textMuted'), fontSize: fontSize.base }}>
          {t('appearance.themeHelp')}
        </p>
        <div role="radiogroup" aria-label={t('appearance.theme')} style={{ display: 'flex', gap: space.md }}>
          {THEME_OPTIONS.map((option) => {
            const selected = preference === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setPreference(option)}
                {...hoverBackground(
                  selected ? token('accent') : token('surface'),
                  selected ? token('accent') : token('surfaceHover'),
                )}
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  borderRadius: radius.md,
                  cursor: 'pointer',
                  fontSize: fontSize.md,
                  color: selected ? token('accentText') : token('text'),
                  background: selected ? token('accent') : token('surface'),
                  border: `1px solid ${selected ? token('accent') : token('border')}`,
                }}
              >
                {t(`appearance.${option}`)}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
