import { describe, expect, it } from 'vitest';
import en from '../locales/en/common.json';
import zhCN from '../locales/zh-CN/common.json';
import ja from '../locales/ja/common.json';
import ko from '../locales/ko/common.json';
import fr from '../locales/fr/common.json';
import de from '../locales/de/common.json';
import es from '../locales/es/common.json';

// English is the reference; every other shipped locale must match its key set
// exactly. A missing key would silently fall back to English at runtime (see
// makeTranslate in ../index.tsx), so parity here is what keeps a locale honest.
const OTHER_LOCALES = { 'zh-CN': zhCN, ja, ko, fr, de, es } as const;
const ALL_LOCALES = { en, ...OTHER_LOCALES } as const;

/** Flatten a nested messages object into dot-path keys. */
function keyPaths(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    keyPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

/** Flatten a nested messages object into its leaf string values. */
function leafValues(obj: unknown): string[] {
  return !obj || typeof obj !== 'object'
    ? [String(obj)]
    : Object.values(obj as Record<string, unknown>).flatMap(leafValues);
}

describe('locale parity', () => {
  const enKeys = keyPaths(en).sort();

  for (const [locale, tree] of Object.entries(OTHER_LOCALES)) {
    it(`${locale} defines exactly the same keys as en`, () => {
      expect(keyPaths(tree).sort()).toEqual(enKeys);
    });
  }

  it('no message value is empty in any locale', () => {
    for (const [locale, tree] of Object.entries(ALL_LOCALES)) {
      for (const value of leafValues(tree)) {
        expect(value.trim(), `${locale} has an empty message`).not.toBe('');
      }
    }
  });
});
