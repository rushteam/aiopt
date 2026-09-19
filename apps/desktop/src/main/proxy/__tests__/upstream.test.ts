import { describe, expect, it } from 'vitest';
import { outboundHeaders, outboundUrl } from '../upstream';

describe('outboundUrl', () => {
  it('appends /v1 when the base has no version segment', () => {
    expect(outboundUrl('openai', 'https://api.example.com')).toBe('https://api.example.com/v1/chat/completions');
    expect(outboundUrl('anthropic', 'https://api.example.com')).toBe('https://api.example.com/v1/messages');
    expect(outboundUrl('openai-responses', 'https://api.example.com')).toBe('https://api.example.com/v1/responses');
  });

  it('does not double a version segment already present', () => {
    expect(outboundUrl('openai', 'https://api.example.com/v1')).toBe('https://api.example.com/v1/chat/completions');
    expect(outboundUrl('anthropic', 'https://api.example.com/v1/')).toBe('https://api.example.com/v1/messages');
    expect(outboundUrl('openai-responses', 'https://api.example.com/v1')).toBe('https://api.example.com/v1/responses');
  });

  it('refuses gemini (never a proxy target)', () => {
    expect(() => outboundUrl('gemini', 'https://x')).toThrow(/unsupported outbound format/);
  });
});

describe('outboundHeaders', () => {
  it('uses a bearer token for both OpenAI dialects', () => {
    for (const fmt of ['openai', 'openai-responses'] as const) {
      const h = outboundHeaders(fmt, 'sk-real');
      expect(h.authorization).toBe('Bearer sk-real');
      expect(h['x-api-key']).toBeUndefined();
    }
  });

  it('uses x-api-key + version header for anthropic', () => {
    const h = outboundHeaders('anthropic', 'sk-real');
    expect(h['x-api-key']).toBe('sk-real');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h.authorization).toBeUndefined();
  });

  it('omits the auth header when no key is present', () => {
    expect(outboundHeaders('openai-responses', null).authorization).toBeUndefined();
    expect(outboundHeaders('anthropic', null)['x-api-key']).toBeUndefined();
  });

  it('refuses gemini', () => {
    expect(() => outboundHeaders('gemini', 'k')).toThrow(/unsupported outbound format/);
  });
});
