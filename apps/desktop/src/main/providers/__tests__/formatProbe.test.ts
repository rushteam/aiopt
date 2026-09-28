import { describe, expect, it } from 'vitest';
import { detectProviderFormats } from '../formatProbe';
import type { FetchLike, FetchLikeResponse } from '../modelCatalog';
import { decodeIpcError, isIpcError } from '../../../shared/ipc-errors';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Reply = { status: number; body?: unknown } | 'network';

/**
 * A fake transport keyed by the tail of the URL: `/chat/completions`, `/responses`,
 * `/messages`, `/models`. Anything not listed answers 404.
 */
function stub(replies: Partial<Record<'chat' | 'responses' | 'messages' | 'models', Reply>>): {
  fetchImpl: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body });
    const path = url.split('?')[0]!;
    const key = path.endsWith('/chat/completions')
      ? 'chat'
      : path.endsWith('/responses')
        ? 'responses'
        : path.endsWith('/messages')
          ? 'messages'
          : path.endsWith('/models')
            ? 'models'
            : null;
    const reply: Reply = (key && replies[key]) || { status: 404 };
    if (reply === 'network') return Promise.reject(new Error(`ECONNREFUSED ${url}`));
    const res: FetchLikeResponse = {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: () => Promise.resolve(reply.body ?? {}),
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

const base = { baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-REAL-secret' };

describe('formatProbe — what counts as served', () => {
  it('a 400 (empty body rejected) marks a POST dialect as served, a 404 does not', async () => {
    const { fetchImpl } = stub({ chat: { status: 400 }, responses: { status: 404 }, messages: { status: 404 } });
    expect(await detectProviderFormats(base, fetchImpl)).toEqual(['openai']);
  });

  it('200, 422 and 429 all count as served; results come back in canonical order', async () => {
    const { fetchImpl } = stub({
      chat: { status: 429 },
      responses: { status: 200 },
      messages: { status: 422 },
    });
    // Canonical order is anthropic, openai, openai-responses, gemini.
    expect(await detectProviderFormats(base, fetchImpl)).toEqual(['anthropic', 'openai', 'openai-responses']);
  });

  it('gemini counts only when /models answers with a `models` list', async () => {
    const looksLikeGemini = stub({ models: { status: 200, body: { models: [{ name: 'models/g' }] } } });
    expect(await detectProviderFormats(base, looksLikeGemini.fetchImpl)).toEqual(['gemini']);

    // An OpenAI-style catalog ({ data: [...] }) on /models is NOT gemini.
    const openaiCatalog = stub({ models: { status: 200, body: { data: [{ id: 'gpt' }] } } });
    expect(await detectProviderFormats(base, openaiCatalog.fetchImpl)).toEqual([]);
  });

  it('returns an empty list when every endpoint answered but none matched', async () => {
    const { fetchImpl } = stub({});
    expect(await detectProviderFormats(base, fetchImpl)).toEqual([]);
  });
});

describe('formatProbe — request shape (no tokens, key in the right place)', () => {
  it('POSTs an empty JSON object with the dialect’s own auth header; GETs the gemini catalog', async () => {
    const { fetchImpl, calls } = stub({});
    await detectProviderFormats(base, fetchImpl);

    const byPath = (tail: string) => calls.find((c) => c.url.split('?')[0]!.endsWith(tail))!;
    const chat = byPath('/chat/completions');
    expect(chat.method).toBe('POST');
    expect(chat.body).toBe('{}');
    expect(chat.headers.authorization).toBe('Bearer sk-REAL-secret');

    const responses = byPath('/responses');
    expect(responses.method).toBe('POST');
    expect(responses.headers.authorization).toBe('Bearer sk-REAL-secret');

    const messages = byPath('/messages');
    expect(messages.method).toBe('POST');
    expect(messages.headers['x-api-key']).toBe('sk-REAL-secret');
    expect(messages.headers.authorization).toBeUndefined();

    const models = byPath('/models');
    expect(models.method).toBe('GET');
    expect(models.url).toBe('https://gw.example.com/v1/models?key=sk-REAL-secret');
    expect(models.headers.authorization).toBeUndefined();
  });

  it('probes every format in one round (parallel), exactly once each', async () => {
    const { fetchImpl, calls } = stub({});
    await detectProviderFormats(base, fetchImpl);
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((c) => c.url)).size).toBe(4);
  });

  it('sends no credential at all when there is no key', async () => {
    const { fetchImpl, calls } = stub({});
    await detectProviderFormats({ baseUrl: base.baseUrl, apiKey: null }, fetchImpl);
    for (const c of calls) {
      expect(c.headers.authorization).toBeUndefined();
      expect(c.headers['x-api-key']).toBeUndefined();
      expect(c.url).not.toContain('key=');
    }
  });

  it('appends /v1beta to a bare base for the gemini probe, and /v1 for the POST dialects', async () => {
    const { fetchImpl, calls } = stub({});
    await detectProviderFormats({ baseUrl: 'https://gw.example.com/', apiKey: null }, fetchImpl);
    const urls = calls.map((c) => c.url).sort();
    expect(urls).toEqual([
      'https://gw.example.com/v1/chat/completions',
      'https://gw.example.com/v1/messages',
      'https://gw.example.com/v1/responses',
      'https://gw.example.com/v1beta/models',
    ]);
  });
});

describe('formatProbe — failures are coded and key-free', () => {
  it('401 on every endpoint with nothing served → UNAUTHORIZED', async () => {
    const { fetchImpl } = stub({
      chat: { status: 401 },
      responses: { status: 401 },
      messages: { status: 401 },
      models: { status: 401 },
    });
    expect(await codeOf(() => detectProviderFormats(base, fetchImpl))).toBe('UNAUTHORIZED');
  });

  it('401 on one endpoint never masks a format that IS served elsewhere', async () => {
    // An auth wall on the anthropic path must not hide that chat completions answered.
    const { fetchImpl } = stub({ chat: { status: 400 }, messages: { status: 403 } });
    expect(await detectProviderFormats(base, fetchImpl)).toEqual(['openai']);
  });

  it('every endpoint unreachable → UPSTREAM_ERROR, and the key is not in the message', async () => {
    const { fetchImpl } = stub({
      chat: 'network',
      responses: 'network',
      messages: 'network',
      models: 'network',
    });
    let message = '';
    try {
      await detectProviderFormats(base, fetchImpl);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(decodeIpcError(message).code).toBe('UPSTREAM_ERROR');
    expect(message).not.toContain('sk-REAL-secret');
  });

  it('a partial network failure is not an error: the reachable answers decide', async () => {
    const { fetchImpl } = stub({ chat: 'network', messages: { status: 400 } });
    expect(await detectProviderFormats(base, fetchImpl)).toEqual(['anthropic']);
  });

  it('a blank base URL is refused with INVALID_PARAMS before any request', async () => {
    const { fetchImpl, calls } = stub({});
    expect(
      await codeOf(() => detectProviderFormats({ baseUrl: '   ', apiKey: 'sk' }, fetchImpl)),
    ).toBe('INVALID_PARAMS');
    expect(calls).toHaveLength(0);
  });
});
