import { describe, expect, it } from 'vitest';
import { loopbackNotExemptFromProxy } from '../proxyEnvCheck';

describe('loopbackNotExemptFromProxy', () => {
  it('is false with no proxy configured', () => {
    expect(loopbackNotExemptFromProxy({})).toBe(false);
    expect(loopbackNotExemptFromProxy({ HTTPS_PROXY: '  ' })).toBe(false);
  });

  it('flags a proxy without a loopback NO_PROXY entry', () => {
    expect(loopbackNotExemptFromProxy({ HTTPS_PROXY: 'http://p:8080' })).toBe(true);
    expect(loopbackNotExemptFromProxy({ http_proxy: 'p:8080', NO_PROXY: 'corp.example' })).toBe(true);
    // `localhost` alone does not cover the literal 127.0.0.1 our baseUrl uses.
    expect(loopbackNotExemptFromProxy({ ALL_PROXY: 'p:1', no_proxy: 'localhost' })).toBe(true);
  });

  it('accepts the usual loopback exemptions', () => {
    for (const NO_PROXY of ['127.0.0.1', 'localhost,127.0.0.1', '*', '127.0.0.0/8', '127.*']) {
      expect(loopbackNotExemptFromProxy({ HTTPS_PROXY: 'http://p:8080', NO_PROXY }), NO_PROXY).toBe(false);
    }
    expect(loopbackNotExemptFromProxy({ HTTPS_PROXY: 'http://p:8080', no_proxy: '127.0.0.1' })).toBe(false);
  });
});
