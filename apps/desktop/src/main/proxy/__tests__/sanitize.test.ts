// Outbound request sanitizing — the per-provider field strip (see ../sanitize.ts).
//
// The security-relevant assertions here are the NEGATIVE ones: that a structural field
// (`tools`, `messages`, `model`) cannot be stripped no matter what the persisted config
// says, and that the returned `dropped` list reports what actually left the body rather
// than what was configured. Those two properties are what keep a corrupted providers.json
// from silently downgrading an agent's capabilities.

import { describe, expect, it } from 'vitest';
import { sanitizeOutboundBody } from '../sanitize';

/** An OpenAI-shaped body carrying the field that motivated this module. */
function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gpt-x',
    messages: [{ role: 'user', content: 'hi' }],
    store: true,
    ...extra,
  };
}

describe('sanitizeOutboundBody — no configuration', () => {
  it('returns the SAME object reference when no fields are configured', () => {
    const input = body();
    for (const cfg of [undefined, []] as const) {
      const out = sanitizeOutboundBody(input, cfg);
      // Identity, not deep equality: the hot path must not copy the body for nothing.
      expect(out.body).toBe(input);
      expect(out.dropped).toEqual([]);
    }
  });

  it('returns the same reference when configured fields are absent from the body', () => {
    const input = body();
    const out = sanitizeOutboundBody(input, ['seed', 'user']);
    expect(out.body).toBe(input);
    expect(out.dropped).toEqual([]);
  });
});

describe('sanitizeOutboundBody — stripping', () => {
  it('removes a configured, present field and leaves the input untouched', () => {
    const input = body();
    const out = sanitizeOutboundBody(input, ['store']);
    expect(out.dropped).toEqual(['store']);
    expect(out.body).not.toHaveProperty('store');
    // The caller's body is not mutated — the proxy may still want the original.
    expect(input).toHaveProperty('store', true);
  });

  it('keeps every field it was not asked to strip', () => {
    const out = sanitizeOutboundBody(body({ temperature: 0.2 }), ['store']);
    expect(out.body).toEqual({
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
    });
  });

  it('strips a field explicitly set to null — the key offends, not the value', () => {
    const out = sanitizeOutboundBody(body({ store: null }), ['store']);
    expect(out.dropped).toEqual(['store']);
    expect(out.body).not.toHaveProperty('store');
  });

  it('reports only fields actually present, not everything configured', () => {
    const out = sanitizeOutboundBody(body({ seed: 7 }), ['store', 'seed', 'user', 'metadata']);
    // `user` and `metadata` were configured but absent, so the log must not claim them.
    expect(out.dropped).toEqual(['store', 'seed']);
  });

  it('reports dropped names in allowlist order regardless of configured order', () => {
    const out = sanitizeOutboundBody(body({ user: 'u', seed: 1 }), ['seed', 'store', 'user']);
    // `store` precedes `user` precedes `seed` in DROPPABLE_REQUEST_FIELDS.safe.
    expect(out.dropped).toEqual(['store', 'user', 'seed']);
  });

  it('strips a reply-changing field when the user opted in', () => {
    const out = sanitizeOutboundBody(body({ response_format: { type: 'json_object' } }), [
      'response_format',
    ]);
    expect(out.dropped).toEqual(['response_format']);
    expect(out.body).not.toHaveProperty('response_format');
  });
});

describe('sanitizeOutboundBody — allowlist is the boundary', () => {
  it('refuses to strip structural capability fields even when configured', () => {
    const input = body({ tools: [{ name: 't' }], tool_choice: 'auto' });
    // Simulates a hand-edited / corrupted providers.json, or a future caller that forgot
    // to normalize: nothing on this list is on the allowlist, so nothing may be removed.
    const out = sanitizeOutboundBody(input, ['tools', 'tool_choice', 'messages', 'model']);
    expect(out.dropped).toEqual([]);
    expect(out.body).toBe(input);
    expect(out.body).toHaveProperty('tools');
    expect(out.body).toHaveProperty('messages');
    expect(out.body).toHaveProperty('model');
  });

  it('ignores an unknown name while honoring an allowlisted one in the same list', () => {
    const out = sanitizeOutboundBody(body({ tools: [{ name: 't' }] }), ['tools', 'store']);
    expect(out.dropped).toEqual(['store']);
    expect(out.body).toHaveProperty('tools');
  });

  it('tolerates whitespace and duplicates in a persisted value', () => {
    const out = sanitizeOutboundBody(body(), ['  store  ', 'store', '']);
    expect(out.dropped).toEqual(['store']);
    expect(out.body).not.toHaveProperty('store');
  });
});
