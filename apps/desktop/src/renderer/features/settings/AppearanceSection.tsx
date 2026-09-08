// Appearance settings — the theme control. Writes go through the config store
// (ThemeProvider.setPreference → config.set), so the choice persists and every
// window updates via the config:changed push.

import type { ThemePreference } from '../../../shared/ipc-channels';
import { useTheme } from '../../themes/ThemeProvider';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';

const OPTIONS: ThemePreference[] = ['system', 'light', 'dark'];

export function AppearanceSection() {
  const t = useT();
  const { preference, setPreference } = useTheme();

  return (
    <section>
      <h2 style={{ margin: '0 0 4px', fontSize: fontSize['2xl'] }}>{t('appearance.title')}</h2>
      <p style={{ margin: '0 0 16px', color: token('textMuted'), fontSize: fontSize.base }}>
        {t('appearance.themeHelp')}
      </p>
      <div role="radiogroup" aria-label={t('appearance.theme')} style={{ display: 'flex', gap: space.md }}>
        {OPTIONS.map((option) => {
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
    </section>
  );
}
