import { describe, expect, it } from 'vitest';
import {
  QUIT_DIALOG_LABELS,
  formatQuitMessage,
  resolveQuitDialogLocale,
  shouldWarnBeforeQuit,
} from '../quitGuard';

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
  it('maps any zh* tag to zh-CN and everything else to en', () => {
    expect(resolveQuitDialogLocale('zh-CN')).toBe('zh-CN');
    expect(resolveQuitDialogLocale('zh-Hant-TW')).toBe('zh-CN');
    expect(resolveQuitDialogLocale('en-US')).toBe('en');
    expect(resolveQuitDialogLocale('ja')).toBe('en');
  });
});

describe('formatQuitMessage', () => {
  it('substitutes the count into each locale message', () => {
    expect(formatQuitMessage(QUIT_DIALOG_LABELS.en, 2)).toContain('2');
    expect(formatQuitMessage(QUIT_DIALOG_LABELS['zh-CN'], 3)).toContain('3');
    // No leftover placeholder.
    expect(formatQuitMessage(QUIT_DIALOG_LABELS.en, 1)).not.toContain('{count}');
  });
});
