// Minimal renderer i18n.
//
// All user-visible copy lives in per-locale `common.json` files — the SAME files
// the glossary gate (scripts/check-i18n-glossary.mjs) scans, so product terms
// stay consistent. This is a deliberately small runtime: detect the locale once,
// resolve dot-path keys, fall back to English. Swap in a full i18n library later
// without changing call sites (`useT()` / `t('settings.title')`).

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LanguagePreference } from '../../shared/ipc-channels';
import en from './locales/en/common.json';
import zhCN from './locales/zh-CN/common.json';
import ja from './locales/ja/common.json';
import ko from './locales/ko/common.json';
import fr from './locales/fr/common.json';
import de from './locales/de/common.json';
import es from './locales/es/common.json';

export type Locale = 'en' | 'zh-CN' | 'ja' | 'ko' | 'fr' | 'de' | 'es';

const MESSAGES: Record<Locale, unknown> = { en, 'zh-CN': zhCN, ja, ko, fr, de, es };

// Map a `navigator.language` prefix onto a supported UI locale. Ordered so the
// only multi-region case (zh) is handled first; the rest match on the 2-letter
// primary subtag. Anything unmatched falls back to English.
const LOCALE_BY_PREFIX: ReadonlyArray<readonly [prefix: string, locale: Locale]> = [
  ['zh', 'zh-CN'],
  ['ja', 'ja'],
  ['ko', 'ko'],
  ['fr', 'fr'],
  ['de', 'de'],
  ['es', 'es'],
  ['en', 'en'],
];

/** The OS locale, mapped onto a supported UI locale (English is the fallback). */
export function detectLocale(): Locale {
  const lang = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : 'en';
  return LOCALE_BY_PREFIX.find(([prefix]) => lang.startsWith(prefix))?.[1] ?? 'en';
}

/** Resolve a stored preference to a concrete locale; `system` follows the OS. */
export function resolveLocale(pref: LanguagePreference): Locale {
  return pref === 'system' ? detectLocale() : pref;
}

/** Resolve a dot-path (`settings.sections.appearance`) against a messages tree. */
function lookup(tree: unknown, key: string): string | undefined {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof node === 'string' ? node : undefined;
}

export type TranslateFn = (key: string) => string;

function makeTranslate(locale: Locale): TranslateFn {
  return (key) => lookup(MESSAGES[locale], key) ?? lookup(MESSAGES.en, key) ?? key;
}

interface I18nContextValue {
  locale: Locale;
  t: TranslateFn;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  children,
  locale: fixedLocale,
}: {
  children: ReactNode;
  /** Force a locale (tests/Storybook). When omitted, the stored preference drives it. */
  locale?: Locale;
}) {
  // First paint uses the OS locale; the stored preference (read async below) then
  // confirms or overrides it. Language flicker is far less jarring than theme, so we
  // avoid a synchronous preload bridge for it.
  const [detected, setDetected] = useState<Locale>(() => fixedLocale ?? detectLocale());

  // Load the persisted preference once, then track live changes via the same
  // config:changed push the theme uses — so a switch applies without a restart.
  useEffect(() => {
    if (fixedLocale) return;
    let active = true;
    void window.aiopt.config.getAll().then((prefs) => {
      if (active) setDetected(resolveLocale(prefs.language));
    });
    const unsubscribe = window.aiopt.config.onChanged((prefs) => {
      setDetected(resolveLocale(prefs.language));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [fixedLocale]);

  const locale = fixedLocale ?? detected;
  const value = useMemo<I18nContextValue>(() => ({ locale, t: makeTranslate(locale) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within an I18nProvider');
  return ctx;
}

/** Convenience: the translate function alone. */
export function useT(): TranslateFn {
  return useI18n().t;
}
