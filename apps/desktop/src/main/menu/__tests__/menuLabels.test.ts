import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MENU_LABELS,
  resolveMenuLocale,
  resolveMenuLocaleForPreference,
  type MenuLocale,
} from '../menuLabels';

// Native menu strings are built in main and never pass through the renderer i18n
// JSON, so the repo-wide glossary gate (which scans only renderer locales) can't
// see them. This test extends that gate's reach to the menu-label table: no menu
// string may use a term's FORBIDDEN rendering for its locale.

// From this test dir (apps/desktop/src/main/menu/__tests__) up to the repo root.
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../../../../..');
const glossary = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'i18n', 'glossary.json'), 'utf8'),
) as {
  locales: string[];
  terms: Array<{ id: string; forbidden?: Record<string, string[]> }>;
};

describe('menu labels vs the product glossary', () => {
  const locales = Object.keys(MENU_LABELS) as MenuLocale[];

  it.each(locales)('locale %s uses no forbidden term rendering', (locale) => {
    const labels = Object.values(MENU_LABELS[locale]);
    for (const term of glossary.terms) {
      for (const forbidden of term.forbidden?.[locale] ?? []) {
        for (const label of labels) {
          expect(
            label.includes(forbidden),
            `menu label "${label}" (${locale}) uses forbidden rendering "${forbidden}" of term ${term.id}`,
          ).toBe(false);
        }
      }
    }
  });

  it('provides labels for every glossary locale', () => {
    // The menu now covers the full glossary set (which is the renderer's set), so this
    // reads the JSON rather than restating a list: adding a locale to the glossary without
    // translating the menu bar should fail here, not ship an English menu over a 日本語 app.
    expect(new Set(locales)).toEqual(new Set(glossary.locales));
  });

  it('gives every locale a complete, non-empty label set', () => {
    // A missing key is `undefined` at runtime, which Electron renders as a blank menu row.
    const keys = Object.keys(MENU_LABELS.en).sort();
    for (const locale of locales) {
      expect(Object.keys(MENU_LABELS[locale]).sort(), `${locale} keys`).toEqual(keys);
      for (const [field, value] of Object.entries(MENU_LABELS[locale])) {
        expect(value.trim().length, `${locale}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it('leaves no label untranslated outside en', () => {
    // Catches a copy-paste that left an English string behind. `skills` is legitimately
    // "Skills" in German and `about`/`settings` share Latin roots in fr/es, so compare
    // only the labels that are ordinary words in every locale we ship.
    const mustDiffer = ['file', 'edit', 'view', 'window', 'help', 'usage', 'quit'] as const;
    for (const locale of locales.filter((l) => l !== 'en')) {
      for (const field of mustDiffer) {
        expect(MENU_LABELS[locale][field], `${locale}.${field}`).not.toBe(MENU_LABELS.en[field]);
      }
    }
  });

  it('resolves OS locales to a supported menu locale', () => {
    expect(resolveMenuLocale('zh-CN')).toBe('zh-CN');
    expect(resolveMenuLocale('zh-Hans')).toBe('zh-CN');
    expect(resolveMenuLocale('en-US')).toBe('en');
    // `fr` used to fall back to en; the menu is translated now.
    expect(resolveMenuLocale('fr')).toBe('fr');
    expect(resolveMenuLocale('de-AT')).toBe('de');
    expect(resolveMenuLocale('ja-JP')).toBe('ja');
    expect(resolveMenuLocale('ko')).toBe('ko');
    expect(resolveMenuLocale('es-419')).toBe('es');
  });

  it('falls back to en for an unshipped or empty tag', () => {
    expect(resolveMenuLocale('pt-BR')).toBe('en');
    expect(resolveMenuLocale('')).toBe('en');
  });

  it('round-trips every supported locale through the resolver', () => {
    for (const locale of locales) {
      expect(resolveMenuLocale(locale), `${locale} must resolve to itself`).toBe(locale);
    }
  });
});

// The regression these guard: the menu and tray builders used to resolve from
// `app.getLocale()` alone, so a user on an English Mac who picked 中文 in Settings got a
// Chinese window with an English menu bar and tray. The stored preference wins; the OS
// locale is only what `system` means.
describe('menu locale for a stored language preference', () => {
  it('prefers an explicit preference over the OS locale', () => {
    expect(resolveMenuLocaleForPreference('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveMenuLocaleForPreference('en', 'zh-CN')).toBe('en');
  });

  it('falls back to the OS locale only for `system`', () => {
    expect(resolveMenuLocaleForPreference('system', 'zh-Hans')).toBe('zh-CN');
    expect(resolveMenuLocaleForPreference('system', 'en-GB')).toBe('en');
  });

  it('honours every locale the renderer can store as a preference', () => {
    // The renderer's language picker and this table now cover the same set, so a stored
    // `ja` is served Japanese menus rather than the en fallback it used to get.
    for (const locale of Object.keys(MENU_LABELS) as MenuLocale[]) {
      expect(resolveMenuLocaleForPreference(locale, 'en-US'), locale).toBe(locale);
    }
  });

  it('falls back to en for a stored value the menu does not cover', () => {
    // Defensive: a preference file hand-edited to an unshipped locale must not produce an
    // undefined label set (every menu row would render blank).
    expect(resolveMenuLocaleForPreference('pt-BR', 'en-US')).toBe('en');
    expect(MENU_LABELS[resolveMenuLocaleForPreference('pt-BR', 'en-US')]).toBeDefined();
  });
});
