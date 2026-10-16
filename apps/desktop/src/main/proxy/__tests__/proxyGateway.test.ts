// The MCP gateway hook: only the exact gateway token reaches it; route tokens are unaffected.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranslationProxy, type TranslationProxy } from '../translationProxy';
import type { ProxyFetch } from '../upstream';

const noopFetch: ProxyFetch = () =>
  Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, body: null, text: () => Promise.resolve('{}') });

const started: TranslationProxy[] = [];
afterEach(async () => {
  for (const p of started.splice(0)) await p.stop();
});

async function start(token: string | null) {
  const handle = vi.fn(async (_req, res, rest: string) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`gw:${rest}`);
  });
  const proxy = createTranslationProxy({ fetchImpl: noopFetch, getKey: () => null, gateway: { token: () => token, handle } });
  started.push(proxy);
  await proxy.start();
  return { base: `http://127.0.0.1:${proxy.getPort()}`, handle };
}

describe('translation proxy: MCP gateway hook', () => {
  it('dispatches the gateway token with the rest of the path', async () => {
    const { base, handle } = await start('mcp-tok');
    const r = await fetch(`${base}/mcp-tok/mcp`, { method: 'POST', body: '{}' });
    expect(await r.text()).toBe('gw:/mcp');
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('a wrong or prefix token never reaches the gateway', async () => {
    const { base, handle } = await start('mcp-tok');
    for (const p of ['/mcp-to/mcp', '/mcp-tokx/mcp', '//mcp']) {
      const r = await fetch(`${base}${p}`, { method: 'POST', body: '{}' });
      expect(r.status).toBe(401);
    }
    expect(handle).not.toHaveBeenCalled();
  });

  it('while the gateway is off (no token) its path is just an unknown token', async () => {
    const { base, handle } = await start(null);
    const r = await fetch(`${base}/mcp-tok/mcp`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
  });
});
