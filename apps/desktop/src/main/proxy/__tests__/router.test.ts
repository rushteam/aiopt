import { describe, expect, it } from 'vitest';
import {
  ProxyRouter,
  assertInboundPath,
  parseTokenFromPath,
  type RouteSpec,
} from '../router';

function spec(overrides: Partial<RouteSpec> = {}): RouteSpec {
  return {
    agentId: 'claude',
    providerId: 'p1',
    inboundFormat: 'anthropic',
    outboundFormat: 'openai',
    upstreamBaseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-chat',
    ...overrides,
  };
}

describe('parseTokenFromPath', () => {
  it('splits the leading token segment from the native suffix', () => {
    expect(parseTokenFromPath('/abc-123/v1/messages')).toEqual({ token: 'abc-123', rest: '/v1/messages' });
  });

  it('drops a query string when isolating the token', () => {
    expect(parseTokenFromPath('/tok/v1/chat/completions?beta=1')).toEqual({
      token: 'tok',
      rest: '/v1/chat/completions',
    });
  });

  it('treats a bare token with no suffix as rest="/"', () => {
    expect(parseTokenFromPath('/only-token')).toEqual({ token: 'only-token', rest: '/' });
  });

  it('tolerates duplicate leading slashes', () => {
    expect(parseTokenFromPath('//tok/v1/messages')).toEqual({ token: 'tok', rest: '/v1/messages' });
  });
});

describe('ProxyRouter', () => {
  it('registers a route and resolves it by token', () => {
    const r = new ProxyRouter();
    const token = r.register(spec());
    expect(token).toBeTruthy();
    expect(r.resolve(token)).toMatchObject({ providerId: 'p1', inboundFormat: 'anthropic' });
    expect(r.has('claude')).toBe(true);
  });

  it('rotates the token on re-register and invalidates the old one', () => {
    const r = new ProxyRouter();
    const first = r.register(spec());
    const second = r.register(spec({ modelId: 'deepseek-reasoner' }));
    expect(second).not.toBe(first);
    expect(r.resolve(first)).toBeUndefined();
    expect(r.resolve(second)?.modelId).toBe('deepseek-reasoner');
  });

  it('unregister removes the route and its token', () => {
    const r = new ProxyRouter();
    const token = r.register(spec());
    r.unregister('claude');
    expect(r.resolve(token)).toBeUndefined();
    expect(r.has('claude')).toBe(false);
  });

  it('resolve returns undefined for unknown or empty tokens', () => {
    const r = new ProxyRouter();
    r.register(spec());
    expect(r.resolve('nope')).toBeUndefined();
    expect(r.resolve('')).toBeUndefined();
  });

  it('keeps independent routes for different agents', () => {
    const r = new ProxyRouter();
    const a = r.register(spec({ agentId: 'claude' }));
    const b = r.register(spec({ agentId: 'opencode', inboundFormat: 'openai', outboundFormat: 'anthropic' }));
    expect(r.resolve(a)?.agentId).toBe('claude');
    expect(r.resolve(b)?.agentId).toBe('opencode');
    r.unregister('claude');
    expect(r.resolve(b)?.agentId).toBe('opencode');
  });
});

describe('assertInboundPath', () => {
  it('accepts the matching native suffix', () => {
    expect(() => assertInboundPath(spec({ inboundFormat: 'anthropic' }), '/v1/messages')).not.toThrow();
    expect(() =>
      assertInboundPath(spec({ inboundFormat: 'openai' }), '/v1/chat/completions'),
    ).not.toThrow();
  });

  it('rejects a suffix that does not match the inbound format', () => {
    expect(() => assertInboundPath(spec({ inboundFormat: 'anthropic' }), '/v1/chat/completions')).toThrow(
      /INVALID_PARAMS/,
    );
  });

  it('accepts a Responses client at both /responses and /v1/responses', () => {
    const responses = spec({ inboundFormat: 'openai-responses', outboundFormat: 'openai' });
    expect(() => assertInboundPath(responses, '/responses')).not.toThrow();
    expect(() => assertInboundPath(responses, '/v1/responses')).not.toThrow();
    expect(() => assertInboundPath(responses, '/responses?stream=true')).not.toThrow();
  });

  it('rejects a Responses route hitting the wrong suffix', () => {
    expect(() =>
      assertInboundPath(spec({ inboundFormat: 'openai-responses' }), '/v1/chat/completions'),
    ).toThrow(/INVALID_PARAMS/);
  });
});
