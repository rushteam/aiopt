// Minimal renderer i18n.
//
// All user-visible copy lives in per-locale `common.json` files — the SAME files
// the glossary gate (scripts/check-i18n-glossary.mjs) scans, so product terms
// stay consistent. This is a deliberately small runtime: detect the locale once,
// resolve dot-path keys, fall back to English. Swap in a full i18n library later
// without changing call sites (`useT()` / `t('settings.title')`).

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import en from './locales/en/common.json';
import zhCN from './locales/zh-CN/common.json';

export type Locale = 'en' | 'zh-CN';

const MESSAGES: Record<Locale, unknown> = { en, 'zh-CN': zhCN };

export function detectLocale(): Locale {
  const lang = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : 'en';
  return lang.startsWith('zh') ? 'zh-CN' : 'en';
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
  locale = detectLocale(),
}: {
  children: ReactNode;
  locale?: Locale;
}) {
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
