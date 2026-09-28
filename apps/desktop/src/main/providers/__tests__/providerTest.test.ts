import { describe, expect, it } from 'vitest';
import { postStatusIndicatesLive, testProviderConnectivity } from '../providerTest';
import type { FetchLike } from '../modelCatalog';
import type { Provider } from '../../../shared/aiProviders';

describe('postStatusIndicatesLive', () => {
  it('treats gateway 500 as live', () => {
    expect(postStatusIndicatesLive(500)).toBe(true);
  });

  it('rejects auth failures', () => {
    expect(postStatusIndicatesLive(401)).toBe(false);
  });
});

describe('testProviderConnectivity', () => {
  const provider: Provider = {
    id: 'p1',
    name: 'LiteLLM',
    apiFormats: ['openai'],
    baseUrl: 'https://gw.example.com/v1',
    models: [{ id: 'gpt-4o' }],
    createdAt: 1,
  };

  it('succeeds when GET /models returns 200', async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      if (init?.method === 'GET' && url.endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-4o' }] }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };

    const result = await testProviderConnectivity(provider, 'sk-test', fetchImpl);
    expect(result).toEqual({ ok: true, latencyMs: expect.any(Number), format: 'openai', error: null });
  });

  it('succeeds on POST 500 when catalog GET fails', async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      if (init?.method === 'GET') {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: false, status: 500, json: async () => ({ error: 'model routing' }) };
    };

    const result = await testProviderConnectivity(provider, 'sk-test', fetchImpl);
    expect(result.ok).toBe(true);
  });
});
