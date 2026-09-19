import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl, isAllowedInAppNavigation } from '../navigation';

const APP_ORIGIN = 'http://localhost:5173';

describe('isAllowedInAppNavigation', () => {
  it('allows same-origin navigation', () => {
    expect(isAllowedInAppNavigation('http://localhost:5173/settings', APP_ORIGIN)).toBe(true);
  });

  it('refuses off-origin navigation', () => {
    expect(isAllowedInAppNavigation('https://evil.example.com/', APP_ORIGIN)).toBe(false);
    expect(isAllowedInAppNavigation('http://localhost:9999/', APP_ORIGIN)).toBe(false);
  });

  it('fails closed on an unparseable target', () => {
    expect(isAllowedInAppNavigation('not a url', APP_ORIGIN)).toBe(false);
  });
});

describe('isAllowedExternalUrl', () => {
  it('allows http and https', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com')).toBe(true);
  });

  it('refuses non-http(s) schemes', () => {
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('aiopt://main/index.html')).toBe(false);
    expect(isAllowedExternalUrl('mailto:a@b.c')).toBe(false);
  });

  it('fails closed on an unparseable target', () => {
    expect(isAllowedExternalUrl('nope')).toBe(false);
  });
});
