import { describe, expect, it } from 'vitest';
import en from '../locales/en/common.json';
import zhCN from '../locales/zh-CN/common.json';

/** Flatten a nested messages object into dot-path keys. */
function keyPaths(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    keyPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe('locale parity', () => {
  it('en and zh-CN define exactly the same keys', () => {
    const enKeys = keyPaths(en).sort();
    const zhKeys = keyPaths(zhCN).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it('no message value is empty', () => {
    for (const [locale, tree] of [['en', en], ['zh-CN', zhCN]] as const) {
      const flatten = (o: unknown): string[] =>
        !o || typeof o !== 'object'
          ? [String(o)]
          : Object.values(o as Record<string, unknown>).flatMap(flatten);
      for (const value of flatten(tree)) {
        expect(value.trim(), `${locale} has an empty message`).not.toBe('');
      }
    }
  });
});
