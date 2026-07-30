import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MENU_LABELS, resolveMenuLocale, type MenuLocale } from '../menuLabels';

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

  it('provides labels for every glossary locale it should cover', () => {
    // The menu covers en + zh-CN; guard against a locale silently going missing.
    expect(new Set(locales)).toEqual(new Set<MenuLocale>(['en', 'zh-CN']));
  });

  it('resolves OS locales to a supported menu locale', () => {
    expect(resolveMenuLocale('zh-CN')).toBe('zh-CN');
    expect(resolveMenuLocale('zh-Hans')).toBe('zh-CN');
    expect(resolveMenuLocale('en-US')).toBe('en');
    expect(resolveMenuLocale('fr')).toBe('en');
  });
});
