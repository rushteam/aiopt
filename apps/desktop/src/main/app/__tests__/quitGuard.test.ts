import { describe, expect, it } from 'vitest';
import {
  QUIT_DIALOG_LABELS,
  formatQuitMessage,
  resolveQuitDialogLocale,
  shouldWarnBeforeQuit,
} from '../quitGuard';
import { MENU_LABELS } from '../../menu/menuLabels';

describe('shouldWarnBeforeQuit', () => {
  it('warns only when enabled AND at least one binding is proxied', () => {
    expect(shouldWarnBeforeQuit(true, 1)).toBe(true);
    expect(shouldWarnBeforeQuit(true, 3)).toBe(true);
  });

  it('does not warn when the preference is off, whatever the count', () => {
    expect(shouldWarnBeforeQuit(false, 5)).toBe(false);
  });

  it('does not warn when nothing is proxied', () => {
    expect(shouldWarnBeforeQuit(true, 0)).toBe(false);
  });
});

describe('resolveQuitDialogLocale', () => {
  it('matches on the language subtag', () => {
    expect(resolveQuitDialogLocale('zh-CN')).toBe('zh-CN');
    expect(resolveQuitDialogLocale('zh-Hant-TW')).toBe('zh-CN');
    expect(resolveQuitDialogLocale('en-US')).toBe('en');
    // `ja` used to fall back to en; the dialog is translated now.
    expect(resolveQuitDialogLocale('ja')).toBe('ja');
    expect(resolveQuitDialogLocale('de-AT')).toBe('de');
  });

  it('falls back to en for a locale the dialog does not cover', () => {
    expect(resolveQuitDialogLocale('pt-BR')).toBe('en');
    expect(resolveQuitDialogLocale('')).toBe('en');
  });

  it('covers exactly the locales the label table has', () => {
    // The dialog and the native menu must offer the same set — a locale present in one
    // and missing from the other is how a half-translated quit prompt happens.
    for (const locale of Object.keys(QUIT_DIALOG_LABELS)) {
      expect(resolveQuitDialogLocale(locale)).toBe(locale);
    }
    expect(Object.keys(QUIT_DIALOG_LABELS).sort()).toEqual(Object.keys(MENU_LABELS).sort());
  });
});

describe('formatQuitMessage', () => {
  it('substitutes the count into each locale message', () => {
    expect(formatQuitMessage(QUIT_DIALOG_LABELS.en, 2)).toContain('2');
    expect(formatQuitMessage(QUIT_DIALOG_LABELS['zh-CN'], 3)).toContain('3');
    // No leftover placeholder.
    expect(formatQuitMessage(QUIT_DIALOG_LABELS.en, 1)).not.toContain('{count}');
  });

  it('every locale carries the {count} placeholder and loses it once filled', () => {
    // A locale whose translator dropped `{count}` would silently print a countless
    // sentence — the substitution would succeed and say nothing.
    for (const [locale, labels] of Object.entries(QUIT_DIALOG_LABELS)) {
      expect(labels.message, `${locale} message must carry {count}`).toContain('{count}');
      const filled = formatQuitMessage(labels, 4);
      expect(filled, `${locale} filled message`).toContain('4');
      expect(filled, `${locale} filled message`).not.toContain('{count}');
    }
  });

  it('no locale ships an empty label', () => {
    for (const [locale, labels] of Object.entries(QUIT_DIALOG_LABELS)) {
      for (const [field, value] of Object.entries(labels)) {
        expect(value.trim().length, `${locale}.${field}`).toBeGreaterThan(0);
      }
    }
  });
});
