// General settings — app-wide appearance and language.
//
//   • Appearance — the theme control (system / light / dark). Writes go through
//     the theme provider (→ config.set), so the choice persists and every window
//     updates via the config:changed push.
//   • Language — the UI locale. A dropdown so it scales as locales are added:
//     each concrete language shows its ENDONYM (its own name — 日本語, Français…),
//     which is invariant across the current UI language, so a speaker always finds
//     their own tongue by the same word. `system` follows the OS locale and is the
//     one option whose label is translated. The write goes through config.set and
//     the I18nProvider re-resolves live off the config:changed push, so the switch
//     applies without a restart.
//
// Proxy mode used to live here too, but it's a provider-ROUTING decision, so its
// control now sits at the top of the Providers page (ProxyControlBar), next to the
// bindings it governs and the loopback address it exposes.

import { useEffect, useState } from 'react';
import type { LanguagePreference, ThemePreference } from '../../../shared/ipc-channels';
import { useTheme } from '../../themes/ThemeProvider';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';

const THEME_OPTIONS: ThemePreference[] = ['system', 'light', 'dark'];

// The language menu, in display order. `system` leads (the default); the rest are
// concrete locales labelled by ENDONYM — the language's own name, never translated,
// so the list reads the same regardless of the current UI language. Add a locale by
// adding a row here (and its common.json + the LanguagePreference union).
const LANGUAGE_MENU: ReadonlyArray<{ value: LanguagePreference; endonym?: string }> = [
  { value: 'system' }, // label comes from t('language.system')
  { value: 'zh-CN', endonym: '中文' },
  { value: 'en', endonym: 'English' },
  { value: 'ja', endonym: '日本語' },
  { value: 'ko', endonym: '한국어' },
  { value: 'fr', endonym: 'Français' },
  { value: 'de', endonym: 'Deutsch' },
  { value: 'es', endonym: 'Español' },
];

export function GeneralSection() {
  const t = useT();
  const { preference, setPreference } = useTheme();
  const [language, setLanguage] = useState<LanguagePreference>('system');
  // The persisted flag behind the "quit while proxied" confirmation dialog. Its
  // "Don't ask again" checkbox writes this false, so this toggle is the way back on.
  const [warnOnQuitWithProxy, setWarnOnQuitWithProxy] = useState<boolean | null>(null);

  // The language and quit-warning preferences live in the same layered config as the
  // theme, but have no dedicated provider — read once, then track the config:changed push.
  useEffect(() => {
    let active = true;
    void window.aiopt.config.getAll().then((prefs) => {
      if (!active) return;
      setLanguage(prefs.language);
      setWarnOnQuitWithProxy(prefs.warnOnQuitWithProxy);
    });
    const unsubscribe = window.aiopt.config.onChanged((prefs) => {
      setLanguage(prefs.language);
      setWarnOnQuitWithProxy(prefs.warnOnQuitWithProxy);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: space['2xl'] }}>
      <Choice
        title={t('appearance.title')}
        help={t('appearance.themeHelp')}
        ariaLabel={t('appearance.theme')}
        options={THEME_OPTIONS}
        selected={preference}
        onSelect={setPreference}
        labelFor={(option) => t(`appearance.${option}`)}
      />
      <LanguagePicker
        title={t('language.title')}
        help={t('language.help')}
        systemLabel={t('language.system')}
        selected={language}
        onSelect={(next) => {
          setLanguage(next); // optimistic; the config:changed echo confirms
          void window.aiopt.config.set('language', next);
        }}
      />
      <Switch
        title={t('general.warnOnQuitWithProxy.label')}
        help={t('general.warnOnQuitWithProxy.help')}
        checked={warnOnQuitWithProxy === true}
        loading={warnOnQuitWithProxy === null}
        onToggle={() => {
          if (warnOnQuitWithProxy === null) return;
          const next = !warnOnQuitWithProxy;
          setWarnOnQuitWithProxy(next); // optimistic; the config:changed echo confirms
          void window.aiopt.config.set('warnOnQuitWithProxy', next);
        }}
      />
    </section>
  );
}

// A titled on/off switch — the same control as the Providers page's proxy switch,
// for a single boolean preference read from the layered config.
function Switch({
  title,
  help,
  checked,
  loading,
  onToggle,
}: {
  title: string;
  help: string;
  checked: boolean;
  loading: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <div
        style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.lg }}
      >
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: fontSize['2xl'] }}>{title}</h2>
          <p style={{ margin: 0, color: token('textMuted'), fontSize: fontSize.base }}>{help}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={title}
          disabled={loading}
          onClick={onToggle}
          style={{
            flexShrink: 0,
            position: 'relative',
            width: 44,
            height: 24,
            borderRadius: 999,
            border: 'none',
            cursor: loading ? 'default' : 'pointer',
            background: checked ? token('accent') : token('borderStrong'),
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
              left: checked ? 22 : 2,
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: token('bg'),
              transition: 'left 120ms ease',
            }}
          />
        </button>
      </div>
    </div>
  );
}

// A titled radiogroup of equal-width segmented buttons — used by the theme control,
// where the option set is small and fixed.
function Choice<T extends string>({
  title,
  help,
  ariaLabel,
  options,
  selected,
  onSelect,
  labelFor,
}: {
  title: string;
  help: string;
  ariaLabel: string;
  options: readonly T[];
  selected: T;
  onSelect: (option: T) => void;
  labelFor: (option: T) => string;
}) {
  return (
    <div>
      <h2 style={{ margin: '0 0 4px', fontSize: fontSize['2xl'] }}>{title}</h2>
      <p style={{ margin: '0 0 16px', color: token('textMuted'), fontSize: fontSize.base }}>{help}</p>
      <div role="radiogroup" aria-label={ariaLabel} style={{ display: 'flex', gap: space.md }}>
        {options.map((option) => {
          const isSelected = selected === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => onSelect(option)}
              {...hoverBackground(
                isSelected ? token('accent') : token('surface'),
                isSelected ? token('accent') : token('surfaceHover'),
              )}
              style={{
                flex: 1,
                padding: '10px 12px',
                borderRadius: radius.md,
                cursor: 'pointer',
                fontSize: fontSize.md,
                color: isSelected ? token('accentText') : token('text'),
                background: isSelected ? token('accent') : token('surface'),
                border: `1px solid ${isSelected ? token('accent') : token('borderStrong')}`,
              }}
            >
              {labelFor(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// A titled dropdown — used by the language control, where the option set grows as
// locales are added and a segmented row would overflow. A native <select> so it
// stays keyboard- and screen-reader-native; styled to match the segmented buttons.
function LanguagePicker({
  title,
  help,
  systemLabel,
  selected,
  onSelect,
}: {
  title: string;
  help: string;
  systemLabel: string;
  selected: LanguagePreference;
  onSelect: (option: LanguagePreference) => void;
}) {
  return (
    <div>
      <h2 style={{ margin: '0 0 4px', fontSize: fontSize['2xl'] }}>{title}</h2>
      <p style={{ margin: '0 0 16px', color: token('textMuted'), fontSize: fontSize.base }}>{help}</p>
      <select
        aria-label={title}
        value={selected}
        onChange={(event) => onSelect(event.target.value as LanguagePreference)}
        style={{
          appearance: 'none',
          minWidth: 200,
          padding: '10px 12px',
          borderRadius: radius.md,
          cursor: 'pointer',
          fontSize: fontSize.md,
          color: token('text'),
          background: token('surface'),
          border: `1px solid ${token('borderStrong')}`,
        }}
      >
        {LANGUAGE_MENU.map(({ value, endonym }) => (
          <option key={value} value={value}>
            {endonym ?? systemLabel}
          </option>
        ))}
      </select>
    </div>
  );
}
