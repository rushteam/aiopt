import { describe, expect, it } from 'vitest';
import { createLogger, sanitizeForLog } from '../logger';

describe('sanitizeForLog', () => {
  it('redacts secret-named fields whatever their value', () => {
    expect(sanitizeForLog({ apiKey: 'abc', access_token: 'x', authorization: 'Bearer y', code: 'UPSTREAM_ERROR' })).toEqual({
      apiKey: '[redacted]',
      access_token: '[redacted]',
      authorization: '[redacted]',
      code: 'UPSTREAM_ERROR',
    });
  });

  it('scrubs credential shapes inside free text', () => {
    const out = sanitizeForLog(
      'fetch failed: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAA at https://x.test/v1?key=AIzaSyA123&x=1 ghp_abcdefghijklmnop eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl',
    ) as string;
    expect(out).not.toMatch(/sk-ant|AIzaSyA123|ghp_abc|eyJhbGci/);
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('key=[redacted]&x=1');
  });

  it('masks user paths and emails but keeps API paths', () => {
    const out = sanitizeForLog(
      "ENOENT: open '/Users/alice/Library/Application Support/x/providers.json' for bob.smith@example.com; C:\\Users\\bob\\a.txt",
    ) as string;
    expect(out).not.toMatch(/alice|bob\.smith|\\bob\\/);
    expect(out).toContain('b***@example.com');
    expect(sanitizeForLog('/v1/chat/completions')).toBe('/v1/chat/completions');
  });

  it('flattens errors, bounds size, and survives cycles', () => {
    const e = new Error('boom /home/carol/x.ts');
    expect(sanitizeForLog(e)).toEqual({ name: 'Error', message: 'boom …/x.ts' });
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(sanitizeForLog(cyc)).toEqual({ a: 1, self: '[circular]' });
    expect((sanitizeForLog('x'.repeat(2000)) as string).length).toBeLessThan(600);
    expect((sanitizeForLog(Array.from({ length: 100 }, (_, i) => i)) as unknown[]).length).toBe(33);
  });

  it('leaves ordinary structured fields untouched', () => {
    const fields = { path: '/v1/messages', status: 400, stream: true, fields: ['store'], bytes: 12, code: 'merge_system' };
    expect(sanitizeForLog(fields)).toEqual(fields);
  });
});

describe('logger', () => {
  it('runs every field through the sanitizer before the sink', () => {
    const lines: string[] = [];
    // A child of a capture logger: build through createLogger and spy on console.log.
    const orig = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      createLogger('t', 'debug').warn('x.failed', { message: 'Bearer sk-1234567890abcdefgh', token: 't' });
    } finally {
      console.log = orig;
    }
    expect(lines[0]).not.toContain('sk-1234567890');
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'x.failed', token: '[redacted]' });
  });
});
