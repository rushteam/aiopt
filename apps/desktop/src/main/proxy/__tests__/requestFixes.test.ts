import { describe, expect, it } from 'vitest';
import { applyExtraBody, autoFixRequest, parseRejectedParam, parseTokenLimit } from '../requestFixes';
import { checkExtraBody } from '../../../shared/aiProviders';

describe('checkExtraBody', () => {
  it('accepts a tuning object and canonicalizes it', () => {
    expect(checkExtraBody({ enable_thinking: false, chat_template_kwargs: { a: 1 } })).toEqual({
      ok: true,
      value: { enable_thinking: false, chat_template_kwargs: { a: 1 } },
    });
  });

  it('refuses request-defining keys, prototype keys, non-objects and oversized values', () => {
    expect(checkExtraBody({ model: 'x' })).toMatchObject({ ok: false, problem: 'denied_key', key: 'model' });
    expect(checkExtraBody({ tools: [] })).toMatchObject({ ok: false, problem: 'denied_key' });
    expect(checkExtraBody(JSON.parse('{"a":{"__proto__":{"x":1}}}'))).toMatchObject({ ok: false, key: '__proto__' });
    expect(checkExtraBody([1])).toMatchObject({ ok: false, problem: 'not_object' });
    expect(checkExtraBody('x')).toMatchObject({ ok: false, problem: 'not_object' });
    expect(checkExtraBody({ big: 'x'.repeat(5000) })).toMatchObject({ ok: false, problem: 'too_large' });
  });
});

describe('applyExtraBody', () => {
  it('deep-merges objects and replaces scalars, without mutating the input', () => {
    const body = { model: 'm', thinking: { type: 'enabled', budget_tokens: 1 }, temperature: 1 };
    const out = applyExtraBody(body, { thinking: { type: 'disabled' }, temperature: 0 });
    expect(out.body).toEqual({ model: 'm', thinking: { type: 'disabled', budget_tokens: 1 }, temperature: 0 });
    expect(out.keys).toEqual(['thinking', 'temperature']);
    expect(body.temperature).toBe(1);
  });

  it('is a no-op (same reference) when nothing is configured', () => {
    const body = { a: 1 };
    expect(applyExtraBody(body, undefined).body).toBe(body);
    expect(applyExtraBody(body, {}).body).toBe(body);
  });
});

describe('parseTokenLimit / parseRejectedParam', () => {
  it('reads common limit phrasings', () => {
    expect(parseTokenLimit('Invalid max_tokens value, the valid range of max_tokens is [1, 8192]')).toBe(8192);
    expect(parseTokenLimit('max_tokens must be between 1 and 4096')).toBe(4096);
    expect(parseTokenLimit('max_tokens: must be less than or equal to 32000')).toBe(32000);
    expect(parseTokenLimit('model not found')).toBeNull();
  });

  it('reads common rejected-parameter phrasings', () => {
    expect(parseRejectedParam("Unsupported parameter: 'store'")).toBe('store');
    expect(parseRejectedParam('Unrecognized request argument supplied: service_tier')).toBe('service_tier');
    expect(parseRejectedParam('"parallel_tool_calls" is not supported')).toBe('parallel_tool_calls');
    expect(parseRejectedParam('stream_options.include_usage: unknown field')).toBeNull();
    expect(parseRejectedParam('Unknown parameter: stream_options.include_usage')).toBe('stream_options');
  });
});

describe('autoFixRequest', () => {
  const base = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }] };

  it('clamps max_tokens to the published limit', () => {
    const out = autoFixRequest('openai', { ...base, max_tokens: 64000 }, 400, 'valid range of max_tokens is [1, 8192]');
    expect(out).toEqual({ fix: 'clamp_max_tokens', body: { ...base, max_tokens: 8192 } });
    // Never raises a value.
    expect(autoFixRequest('openai', { ...base, max_tokens: 100 }, 400, 'range [1, 8192] max_tokens')).toBeNull();
  });

  it('renames max_tokens for reasoning models', () => {
    const out = autoFixRequest(
      'openai',
      { model: 'o3-mini', messages: [], max_tokens: 10 },
      400,
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    );
    expect(out).toEqual({ fix: 'max_completion_tokens', body: { model: 'o3-mini', messages: [], max_completion_tokens: 10 } });
  });

  it('drops only safe / proxy-added parameters', () => {
    expect(autoFixRequest('openai', { ...base, store: true }, 400, "Unsupported parameter: 'store'")).toEqual({
      fix: 'drop_param',
      body: base,
    });
    expect(
      autoFixRequest('openai', { ...base, stream_options: { include_usage: true } }, 422, 'unknown field: stream_options'),
    ).toMatchObject({ fix: 'drop_param' });
    // tools / response_format are never silently removed.
    expect(autoFixRequest('openai', { ...base, tools: [] }, 400, "Unsupported parameter: 'tools'")).toBeNull();
    expect(autoFixRequest('openai', { ...base, response_format: {} }, 400, "Unsupported parameter: 'response_format'")).toBeNull();
  });

  it('merges system / developer messages into one leading system message', () => {
    const body = {
      model: 'm',
      messages: [
        { role: 'system', content: 'a' },
        { role: 'user', content: 'q' },
        { role: 'developer', content: 'b' },
      ],
    };
    expect(autoFixRequest('openai', body, 400, 'system message must be at the beginning')).toEqual({
      fix: 'merge_system',
      body: { model: 'm', messages: [{ role: 'system', content: 'a\n\nb' }, { role: 'user', content: 'q' }] },
    });
    // Already canonical → nothing to do.
    expect(
      autoFixRequest('openai', { model: 'm', messages: [{ role: 'system', content: 'a' }, { role: 'user', content: 'q' }] }, 400, 'system'),
    ).toBeNull();
  });

  it('ignores non-400/422 statuses', () => {
    expect(autoFixRequest('openai', { ...base, store: true }, 500, "Unsupported parameter: 'store'")).toBeNull();
  });
});
