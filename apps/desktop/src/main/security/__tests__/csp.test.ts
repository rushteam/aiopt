import { describe, expect, it } from 'vitest';
import { buildCspHeaderValue } from '../csp';

// Parse a CSP header string into a directive → values map for assertions.
function parse(header: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of header.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}

describe('buildCspHeaderValue', () => {
  it('production script-src is exactly self — no unsafe-inline / unsafe-eval / remote', () => {
    const csp = parse(buildCspHeaderValue(false));
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['script-src']).not.toContain("'unsafe-inline'");
    expect(csp['script-src']).not.toContain("'unsafe-eval'");
  });

  it('production locks down object/frame/base and default-src', () => {
    const csp = parse(buildCspHeaderValue(false));
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
  });

  it('production never allows unsafe-eval anywhere in the header', () => {
    expect(buildCspHeaderValue(false)).not.toContain("'unsafe-eval'");
  });

  it('dev relaxations exist but stay confined to dev', () => {
    const dev = parse(buildCspHeaderValue(true));
    // Dev needs these for Vite HMR; they must never reach prod (asserted above).
    expect(dev['script-src']).toContain("'unsafe-inline'");
    expect(dev['connect-src']).toContain('ws:');
  });
});
