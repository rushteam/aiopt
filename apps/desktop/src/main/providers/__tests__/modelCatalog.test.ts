import { describe, expect, it } from 'vitest';
import { fetchProviderModels, type FetchLike, type FetchLikeResponse } from '../modelCatalog';
import { decodeIpcError, isIpcError } from '../../../shared/ipc-errors';

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

/** A fake transport that records each request and returns a canned response. */
function stub(opts: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throwNetwork?: boolean;
}): { fetchImpl: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    if (opts.throwNetwork) return Promise.reject(new Error('network down'));
    const res: FetchLikeResponse = {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: () => Promise.resolve(opts.body ?? {}),
    };
    return Promise.resolve(res);
  };
  return { fetchImpl, calls };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (isIpcError(err)) return err.code;
    if (err instanceof Error) return decodeIpcError(err.message).code;
  }
  throw new Error('expected the call to throw a coded error');
}

describe('modelCatalog — openai', () => {
  it('GETs {base}/models with a bearer token and dedupes ids', async () => {
    const { fetchImpl, calls } = stub({
      body: { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o' }, { id: 'o1' }] },
    });
    const models = await fetchProviderModels(
      { apiFormat: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-o' },
      fetchImpl,
    );
    expect(calls[0]!.url).toBe('https://api.example.com/v1/models');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-o');
    expect(models).toEqual([{ id: 'gpt-4o' }, { id: 'o1' }]);
  });

  it('appends /v1 when the base URL has no version segment', async () => {
    const { fetchImpl, calls } = stub({ body: { data: [] } });
    await fetchProviderModels(
      { apiFormat: 'openai', baseUrl: 'https://api.example.com/', apiKey: null },
      fetchImpl,
    );
    expect(calls[0]!.url).toBe('https://api.example.com/v1/models');
    expect(calls[0]!.headers.authorization).toBeUndefined(); // no key → no auth header
  });
});

describe('modelCatalog — anthropic', () => {
  it('GETs /v1/models with x-api-key + anthropic-version and reads the id', async () => {
    const { fetchImpl, calls } = stub({
      body: { data: [{ id: 'claude-opus-5', display_name: 'Opus' }] },
    });
    const models = await fetchProviderModels(
      { apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-a' },
      fetchImpl,
    );
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models');
    expect(calls[0]!.headers['x-api-key']).toBe('sk-a');
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(models).toEqual([{ id: 'claude-opus-5' }]);
  });

  it('does not double the version when the base URL already ends in /v1', async () => {
    const { fetchImpl, calls } = stub({ body: { data: [] } });
    await fetchProviderModels(
      { apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-a' },
      fetchImpl,
    );
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models');
  });
});

describe('modelCatalog — gemini', () => {
  it('puts the key in the query and strips the models/ prefix from the id', async () => {
    const { fetchImpl, calls } = stub({
      body: { models: [{ name: 'models/gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' }] },
    });
    const models = await fetchProviderModels(
      {
        apiFormat: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'sk-g',
      },
      fetchImpl,
    );
    expect(calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?key=sk-g',
    );
    // Key travels in the query only — never as a header.
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.headers['x-api-key']).toBeUndefined();
    expect(models).toEqual([{ id: 'gemini-1.5-pro' }]);
  });
});

describe('modelCatalog — failures map to coded, key-free errors', () => {
  it('401 / 403 → UNAUTHORIZED', async () => {
    const { fetchImpl } = stub({ ok: false, status: 401 });
    expect(
      await codeOf(() =>
        fetchProviderModels(
          { apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk' },
          fetchImpl,
        ),
      ),
    ).toBe('UNAUTHORIZED');
  });

  it('other non-2xx → UPSTREAM_ERROR', async () => {
    const { fetchImpl } = stub({ ok: false, status: 500 });
    expect(
      await codeOf(() =>
        fetchProviderModels(
          { apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk' },
          fetchImpl,
        ),
      ),
    ).toBe('UPSTREAM_ERROR');
  });

  it('a network throw → UPSTREAM_ERROR and never surfaces the key', async () => {
    const { fetchImpl } = stub({ throwNetwork: true });
    let message = '';
    try {
      await fetchProviderModels(
        { apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-super-secret' },
        fetchImpl,
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(decodeIpcError(message).code).toBe('UPSTREAM_ERROR');
    expect(message).not.toContain('sk-super-secret');
  });
});
