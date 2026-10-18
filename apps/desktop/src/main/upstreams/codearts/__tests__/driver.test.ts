import { describe, expect, it } from 'vitest';
import type { ProxyFetchResponse } from '../../../proxy/upstream';
import type { Provider } from '../../../../shared/aiProviders';
import type { UpstreamEvent } from '../../types';
import type { CodeArtsSession } from '../session';
import { serializeCodeArtsSession } from '../session';
import { createCodeArtsDriver, isCodeArtsOAuthProvider, type CodeArtsFetch } from '../driver';
import { CODEARTS_CHAT_BASE } from '../constants';

const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: 'x', y: 'y', d: 'd' };

const session: CodeArtsSession = {
  accessKeyId: 'AK',
  secretAccessKey: 'SK',
  securityToken: 'ST',
  expiresAt: '2099-01-01T00:00:00Z',
  refreshToken: 'rt',
  codeVerifier: 'cv',
  dpopPrivateKeyJwk: jwk,
};

const provider = {
  id: 'p-codearts',
  credentialMode: 'oauth',
  oauth: { kind: 'huawei_codearts' },
} as unknown as Provider;

function response(status: number, text: string, type = 'text/event-stream'): ProxyFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (n.toLowerCase() === 'content-type' ? type : null) },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
    text: () => Promise.resolve(text),
  };
}

async function all(it: AsyncIterable<UpstreamEvent>): Promise<UpstreamEvent[]> {
  const out: UpstreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('CodeArts driver', () => {
  it('handles only huawei_codearts oauth providers', () => {
    const d = createCodeArtsDriver({
      fetchImpl: () => Promise.reject(new Error('x')),
      auth: { current: async () => session },
    });
    expect(d.handles(provider)).toBe(true);
    expect(isCodeArtsOAuthProvider(provider)).toBe(true);
    expect(
      d.handles({
        ...provider,
        oauth: { kind: 'generic_pkce', clientId: 'c', authorizeUrl: 'https://a', tokenUrl: 'https://t' },
      } as Provider),
    ).toBe(false);
  });

  it('signs chat with SDK-HMAC and streams OpenAI SSE', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n` + 'data: [DONE]\n\n';
    const fetchImpl: CodeArtsFetch = (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return Promise.resolve(response(200, sse));
    };
    const bound = createCodeArtsDriver({
      fetchImpl,
      auth: { current: async () => session },
    }).bind(provider);
    const r = await bound.chat({ model: 'GLM-5.2', messages: [{ role: 'user', content: 'q' }] });
    if (!('events' in r)) throw new Error('expected events');
    const out = await all(r.events);
    expect(out.some((e) => 'text' in e && e.text === 'hi')).toBe(true);
    expect(calls[0]!.url).toBe(`${CODEARTS_CHAT_BASE}/chat/completions`);
    expect(calls[0]!.headers.Authorization).toMatch(/^SDK-HMAC-SHA256 Access=AK,/);
    expect(calls[0]!.headers['x-security-token']).toBe('ST');
    expect(calls[0]!.headers.maas_type).toBeUndefined();
    expect(calls[0]!.headers['Chat-Id']).toMatch(/^[0-9a-f]+$/);
    expect(JSON.parse(calls[0]!.body!).stream).toBe(true);
    // Session JSON stays main-side — never put into outbound Authorization as Bearer.
    expect(calls[0]!.headers.Authorization).not.toContain(serializeCodeArtsSession(session));
  });

  it('adds a signed maas_type header for benefit models', async () => {
    const headers: Record<string, string>[] = [];
    const fetchImpl: CodeArtsFetch = (_url, init) => {
      headers.push(init.headers);
      return Promise.resolve(response(200, 'data: [DONE]\n\n'));
    };
    const bound = createCodeArtsDriver({
      fetchImpl,
      auth: { current: async () => session },
    }).bind(provider);
    await bound.chat({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'q' }] });
    expect(headers[0]!.maas_type).toBe('benefit');
    expect(headers[0]!.Authorization).toContain('maas_type');
  });

  it('reports signed-out as 401', async () => {
    const out = createCodeArtsDriver({
      fetchImpl: () => Promise.reject(new Error('x')),
      auth: { current: async () => null },
    }).bind(provider);
    expect(await out.chat({ messages: [] })).toEqual({ error: { status: 401, message: 'no credential' } });
  });
});
