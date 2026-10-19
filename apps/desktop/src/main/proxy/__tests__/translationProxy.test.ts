import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createTranslationProxy, safeRetryAfter, type TranslationProxy } from '../translationProxy';
import type { ProxyStateStore, PersistedRoute } from '../proxyStore';
import type { ProxyFetch } from '../upstream';
import type { RouteSpec } from '../router';
import type { RoutingDecisionInput } from '../routing/runtime';

/** A never-called transport — these tests exercise identity/lifecycle, not forwarding. */
const noopFetch: ProxyFetch = () =>
  Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, body: null, text: () => Promise.resolve('{}') });

/** In-memory ProxyStateStore capturing what the proxy persists. */
function memoryProxyState(seed: { port?: number | null; routes?: PersistedRoute[] } = {}): ProxyStateStore & {
  ports: number[];
  savedRoutes: PersistedRoute[][];
} {
  let port = seed.port ?? null;
  let routes = seed.routes ?? [];
  const ports: number[] = [];
  const savedRoutes: PersistedRoute[][] = [];
  return {
    ports,
    savedRoutes,
    loadPort: () => port,
    savePort: (p) => {
      port = p;
      ports.push(p);
    },
    loadRoutes: () => routes.map((r) => ({ token: r.token, spec: { ...r.spec } })),
    saveRoutes: (next) => {
      routes = next;
      savedRoutes.push(next);
    },
  };
}

function spec(overrides: Partial<RouteSpec> = {}): RouteSpec {
  return {
    agentId: 'claude',
    providerId: 'p1',
    inboundFormat: 'anthropic',
    outboundFormat: 'anthropic',
    upstreamBaseUrl: 'https://api.anthropic.com',
    modelId: 'claude-x',
    ...overrides,
  };
}

describe('translation proxy — persisted identity', () => {
  const started: TranslationProxy[] = [];
  const blockers: Server[] = [];

  afterEach(async () => {
    for (const p of started.splice(0)) await p.stop();
    for (const s of blockers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });

  it('saves the bound port on start', async () => {
    const state = memoryProxyState();
    const proxy = createTranslationProxy({ fetchImpl: noopFetch, getKey: () => null, persistence: state });
    started.push(proxy);
    await proxy.start();
    expect(proxy.getPort()).toBeGreaterThan(0);
    expect(state.ports).toEqual([proxy.getPort()]);
  });

  it('reuses a free persisted port', async () => {
    // Grab a port, free it, then ask the proxy to reuse it.
    const wanted = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const state = memoryProxyState({ port: wanted });
    const proxy = createTranslationProxy({ fetchImpl: noopFetch, getKey: () => null, persistence: state });
    started.push(proxy);
    await proxy.start();
    expect(proxy.getPort()).toBe(wanted);
  });

  it('falls back to an OS-assigned port when the persisted one is taken', async () => {
    // Hold the persisted port so the proxy must fall back.
    const wanted = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => {
        blockers.push(s);
        resolve((s.address() as AddressInfo).port);
      });
    });
    const state = memoryProxyState({ port: wanted });
    const proxy = createTranslationProxy({ fetchImpl: noopFetch, getKey: () => null, persistence: state });
    started.push(proxy);
    await proxy.start();
    expect(proxy.getPort()).toBeGreaterThan(0);
    expect(proxy.getPort()).not.toBe(wanted);
    // The freshly-bound port is persisted for next time.
    expect(state.ports.at(-1)).toBe(proxy.getPort());
  });

  it('rehydrates a persisted route so endpointFor returns the same token', async () => {
    const state = memoryProxyState({ routes: [{ token: 'cached-tok', spec: spec() }] });
    const proxy = createTranslationProxy({ fetchImpl: noopFetch, getKey: () => null, persistence: state });
    started.push(proxy);
    await proxy.start();
    expect(proxy.isRouted('claude')).toBe(true);
    const ep = proxy.endpointFor('claude');
    expect(ep?.token).toBe('cached-tok');
    expect(ep?.baseUrl).toBe(`http://127.0.0.1:${proxy.getPort()}/cached-tok`);
    expect(ep?.modelId).toBe('claude-x');
  });

  it('persists routes on register and unregister', async () => {
    const state = memoryProxyState();
    const proxy = createTranslationProxy({ fetchImpl: noopFetch, getKey: () => null, persistence: state });
    started.push(proxy);
    await proxy.start();

    const { token } = proxy.registerRoute(spec());
    expect(state.savedRoutes.at(-1)).toEqual([{ token, spec: spec() }]);

    proxy.unregisterRoute({ agentId: 'claude' });
    expect(state.savedRoutes.at(-1)).toEqual([]);
    expect(proxy.isRouted('claude')).toBe(false);
  });

  it('endpointFor returns null for an unrouted agent', async () => {
    const proxy = createTranslationProxy({ fetchImpl: noopFetch, getKey: () => null });
    started.push(proxy);
    await proxy.start();
    expect(proxy.endpointFor('codex')).toBeNull();
    expect(proxy.isRouted('codex')).toBe(false);
  });
});

describe('translation proxy — rebindPort', () => {
  const started: TranslationProxy[] = [];

  afterEach(async () => {
    for (const p of started.splice(0)) await p.stop();
  });

  it('moves to a fresh port, preserves routes/tokens, and persists the new port', async () => {
    const state = memoryProxyState();
    const proxy = createTranslationProxy({ fetchImpl: noopFetch, getKey: () => null, persistence: state });
    started.push(proxy);
    await proxy.start();
    const { token } = proxy.registerRoute(spec());
    const before = proxy.getPort();

    const next = await proxy.rebindPort();
    expect(next).not.toBe(before);
    expect(proxy.getPort()).toBe(next);
    // The route survives the move — same token, only the port segment of the URL changes.
    expect(proxy.isRouted('claude')).toBe(true);
    const ep = proxy.endpointFor('claude');
    expect(ep?.token).toBe(token);
    expect(ep?.baseUrl).toBe(`http://127.0.0.1:${next}/${token}`);
    // The fresh port is persisted for the next launch.
    expect(state.ports.at(-1)).toBe(next);
  });

  it('throws when the proxy has not been started', async () => {
    const proxy = createTranslationProxy({ fetchImpl: noopFetch, getKey: () => null });
    await expect(proxy.rebindPort()).rejects.toThrow();
  });
});

describe('translation proxy — per-provider request sanitizing', () => {
  const started: TranslationProxy[] = [];

  afterEach(async () => {
    for (const p of started.splice(0)) await p.stop();
  });

  /** Captures the body the proxy actually put on the wire. */
  function recordingFetch(): { impl: ProxyFetch; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    const impl: ProxyFetch = (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        body: null,
        text: () => Promise.resolve(JSON.stringify({ id: 'x', content: [] })),
      });
    };
    return { impl, bodies };
  }

  /**
   * Drive one real request through a started proxy on a SAME-format (identity passthrough)
   * route — the case that motivated sanitize.ts, since the body is otherwise forwarded
   * verbatim and a strict upstream rejects the whole call.
   */
  async function post(
    getDropFields: ((providerId: string) => readonly string[] | undefined) | undefined,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const { impl, bodies } = recordingFetch();
    const proxy = createTranslationProxy({ fetchImpl: impl, getKey: () => 'sk-test', getDropFields });
    started.push(proxy);
    await proxy.start();
    const { token } = proxy.registerRoute(spec());
    const res = await fetch(`http://127.0.0.1:${proxy.getPort()}/${token}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return bodies;
  }

  it('strips a configured field from the forwarded body', async () => {
    const bodies = await post(() => ['store'], {
      model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
      store: true,
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('store');
    expect(bodies[0]).toHaveProperty('messages');
  });

  it('forwards the body unchanged when no fields are configured', async () => {
    for (const deps of [undefined, () => undefined, () => []] as const) {
      const bodies = await post(deps, {
        model: 'claude-x',
        messages: [{ role: 'user', content: 'hi' }],
        store: true,
      });
      // Unconfigured is the default: a passthrough route must stay byte-faithful.
      expect(bodies[0]).toHaveProperty('store', true);
    }
  });

  it('resolves the field list per provider, at request time', async () => {
    // Live resolution (like getKey) is what lets a provider edit take effect without
    // rebinding the agent or rotating its token.
    const calls: string[] = [];
    const bodies = await post(
      (providerId) => {
        calls.push(providerId);
        return providerId === 'p1' ? ['store'] : undefined;
      },
      { model: 'claude-x', messages: [], store: true },
    );
    expect(calls).toEqual(['p1']);
    expect(bodies[0]).not.toHaveProperty('store');
  });

  it('never strips a structural field, whatever the resolver returns', async () => {
    const bodies = await post(() => ['tools', 'messages', 'model'], {
      model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 't' }],
    });
    expect(bodies[0]).toHaveProperty('model', 'claude-x');
    expect(bodies[0]).toHaveProperty('messages');
    expect(bodies[0]).toHaveProperty('tools');
  });

  it('fails closed when the resolver throws, rather than forwarding an unsanitized body', async () => {
    const { impl, bodies } = recordingFetch();
    const proxy = createTranslationProxy({
      fetchImpl: impl,
      getKey: () => 'sk-test',
      getDropFields: () => {
        throw new Error('store unavailable');
      },
    });
    started.push(proxy);
    await proxy.start();
    const { token } = proxy.registerRoute(spec());
    const res = await fetch(`http://127.0.0.1:${proxy.getPort()}/${token}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-x', messages: [] }),
    });
    // The resolver is a synchronous store lookup, so this is a can't-happen guard — but the
    // direction matters: on a credentialed path, a body whose sanitizing state is unknown must
    // not reach the upstream. The throw surfaces as a coded proxy error and nothing is sent.
    expect(res.status).not.toBe(200);
    expect(bodies).toHaveLength(0);
  });
});

describe('translation proxy — prompt-cache breakpoints', () => {
  const started: TranslationProxy[] = [];

  afterEach(async () => {
    for (const p of started.splice(0)) await p.stop();
  });

  async function send(
    getPromptCache: (() => boolean) | undefined,
    route: Partial<RouteSpec>,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const bodies: Record<string, unknown>[] = [];
    const impl: ProxyFetch = (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        body: null,
        text: () =>
          Promise.resolve(
            JSON.stringify({ id: 'x', model: 'm', content: [], stop_reason: 'end_turn', usage: {} }),
          ),
      });
    };
    const proxy = createTranslationProxy({ fetchImpl: impl, getKey: () => 'sk-test', getPromptCache });
    started.push(proxy);
    await proxy.start();
    const { token } = proxy.registerRoute(spec(route));
    const res = await fetch(`http://127.0.0.1:${proxy.getPort()}/${token}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(bodies).toHaveLength(1);
    return bodies[0]!;
  }

  const chat = {
    model: 'gpt',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ],
  };

  it('adds breakpoints to a translated Anthropic-bound body when enabled', async () => {
    const out = await send(() => true, { agentId: 'opencode', inboundFormat: 'openai' }, '/v1/chat/completions', chat);
    expect(JSON.stringify(out)).toContain('"cache_control":{"type":"ephemeral"}');
  });

  it('leaves the body alone when disabled or not configured', async () => {
    for (const flag of [undefined, () => false]) {
      const out = await send(flag, { agentId: 'opencode', inboundFormat: 'openai' }, '/v1/chat/completions', chat);
      expect(JSON.stringify(out)).not.toContain('cache_control');
    }
  });

  it('never touches a non-Anthropic upstream', async () => {
    const out = await send(
      () => true,
      { inboundFormat: 'openai', outboundFormat: 'openai', upstreamBaseUrl: 'https://api.openai.com' },
      '/v1/chat/completions',
      chat,
    );
    expect(JSON.stringify(out)).not.toContain('cache_control');
  });
});

describe('translation proxy — Gemini upstream', () => {
  const started: TranslationProxy[] = [];

  afterEach(async () => {
    for (const p of started.splice(0)) await p.stop();
  });

  function sseBody(frames: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(enc.encode(f));
        controller.close();
      },
    });
  }

  async function run(
    stream: boolean,
    reply: { json?: unknown; sse?: string[] },
  ): Promise<{ url: string; headers: Record<string, string>; sent: Record<string, unknown>; res: Response; usage: unknown[] }> {
    let url = '';
    let headers: Record<string, string> = {};
    let sent: Record<string, unknown> = {};
    const usage: unknown[] = [];
    const impl: ProxyFetch = (u, init) => {
      url = u;
      headers = init.headers;
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: reply.sse ? sseBody(reply.sse) : null,
        text: () => Promise.resolve(JSON.stringify(reply.json ?? {})),
      });
    };
    const proxy = createTranslationProxy({
      fetchImpl: impl,
      getKey: () => 'sk-gem',
      recordUsage: (e) => usage.push(e),
    });
    started.push(proxy);
    await proxy.start();
    const { token } = proxy.registerRoute(
      spec({ outboundFormat: 'gemini', upstreamBaseUrl: 'https://g.example', modelId: 'gemini-2.5-pro' }),
    );
    const res = await fetch(`http://127.0.0.1:${proxy.getPort()}/${token}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', max_tokens: 64, stream, messages: [{ role: 'user', content: 'hi' }] }),
    });
    return { url, headers, sent, res, usage };
  }

  it('translates a non-streaming call and keeps the key out of the URL', async () => {
    const { url, headers, sent, res, usage } = await run(false, {
      json: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      },
    });
    expect(url).toBe('https://g.example/v1beta/models/gemini-2.5-pro:generateContent');
    expect(url).not.toContain('sk-gem');
    expect(headers['x-goog-api-key']).toBe('sk-gem');
    expect(sent).toEqual({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 64 } });
    const body = (await res.json()) as { content: unknown[]; usage: unknown };
    expect(body.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(usage[0]).toMatchObject({ ok: true, streamed: false, inputTokens: 5, outputTokens: 2 });
  });

  it('streams via streamGenerateContent and closes the message even without a finish chunk', async () => {
    const { url, res, usage } = await run(true, {
      sse: [
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'he' }] } }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'llo' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } })}\n\n`,
      ],
    });
    expect(url).toBe('https://g.example/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
    const text = await res.text();
    expect(text).toContain('"text":"he"');
    expect(text).toContain('"text":"llo"');
    expect(text).toContain('event: message_stop');
    expect(usage[0]).toMatchObject({ ok: true, streamed: true, inputTokens: 3, outputTokens: 4 });
  });
});

describe('translation proxy — extra body + auto-fix retry', () => {
  const started: TranslationProxy[] = [];
  afterEach(async () => {
    for (const p of started.splice(0)) await p.stop();
  });

  async function run(
    replies: { status: number; text: string; retryAfter?: string }[],
    extra?: Record<string, unknown>,
  ): Promise<{ status: number; body: string; sent: Record<string, unknown>[]; retryAfter: string | null }> {
    const sent: Record<string, unknown>[] = [];
    const impl: ProxyFetch = (_url, init) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const r = replies[Math.min(sent.length - 1, replies.length - 1)]!;
      return Promise.resolve({
        ok: r.status < 400,
        status: r.status,
        headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? (r.retryAfter ?? null) : 'application/json') },
        body: null,
        text: () => Promise.resolve(r.text),
      });
    };
    const proxy = createTranslationProxy({ fetchImpl: impl, getKey: () => 'sk', getExtraBody: () => extra });
    started.push(proxy);
    await proxy.start();
    const { token } = proxy.registerRoute(spec());
    const res = await fetch(`http://127.0.0.1:${proxy.getPort()}/${token}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-x', max_tokens: 64000, messages: [{ role: 'user', content: 'hi' }] }),
    });
    return { status: res.status, body: await res.text(), sent, retryAfter: res.headers.get('retry-after') };
  }

  const ok = { status: 200, text: JSON.stringify({ id: 'x', content: [] }) };

  it('merges the provider extraBody into the outbound body', async () => {
    const { sent } = await run([ok], { thinking: { type: 'disabled' } });
    expect(sent[0]).toMatchObject({ thinking: { type: 'disabled' }, model: 'claude-x' });
  });

  it('retries once with a clamped max_tokens and never forwards the upstream error body', async () => {
    const { status, sent } = await run([{ status: 400, text: 'max_tokens: must be between 1 and 8192' }, ok]);
    expect(status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.max_tokens).toBe(8192);
  });

  it('gives up after one retry with the generic envelope', async () => {
    const secret = 'max_tokens must be between 1 and 8192 sk-leaky';
    const { status, body, sent } = await run([{ status: 400, text: secret }]);
    expect(sent).toHaveLength(2);
    expect(status).toBe(502);
    expect(body).not.toContain('sk-leaky');
  });

  it('does not retry an error it cannot fix', async () => {
    const { sent } = await run([{ status: 400, text: 'content policy' }]);
    expect(sent).toHaveLength(1);
  });

  it('passes a 429 through with a safe Retry-After (body still generic)', async () => {
    const r = await run([{ status: 429, text: 'slow down sk-leaky', retryAfter: '30' }]);
    expect(r.status).toBe(429);
    expect(r.retryAfter).toBe('30');
    expect(r.body).not.toContain('sk-leaky');
    expect(r.sent).toHaveLength(1);
  });

  it('passes 529 through and drops a malformed Retry-After', async () => {
    const r = await run([{ status: 529, text: 'x', retryAfter: '30\r\nx-evil: 1' }]);
    expect(r.status).toBe(529);
    expect(r.retryAfter).toBeNull();
  });
});

describe('safeRetryAfter', () => {
  it('accepts seconds (capped) and HTTP dates only', () => {
    expect(safeRetryAfter('120')).toBe('120');
    expect(safeRetryAfter('999999')).toBe('86400');
    expect(safeRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    expect(safeRetryAfter('-1')).toBeNull();
    expect(safeRetryAfter('soon')).toBeNull();
    expect(safeRetryAfter(null)).toBeNull();
  });
});

describe('translation proxy — routing group failover', () => {
  const started: TranslationProxy[] = [];
  afterEach(async () => {
    for (const p of started.splice(0)) await p.stop();
  });

  it('tries the next member on 503 and answers from the second seat', async () => {
    const sentUrls: string[] = [];
    const impl: ProxyFetch = (url) => {
      sentUrls.push(String(url));
      if (sentUrls.length === 1) {
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: { get: () => null },
          body: null,
          text: () => Promise.resolve('busy'),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        body: null,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              id: 'msg_ok',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'ok' }],
              model: 'm2',
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          ),
      });
    };

    const resting: string[] = [];
    const successes: string[] = [];
    const decisions: RoutingDecisionInput[] = [];
    const proxy = createTranslationProxy({
      fetchImpl: impl,
      getKey: () => 'sk',
      routing: {
        cooldown: {
          rest: () => {},
          isResting: () => false,
          restingSeats: () => new Set(),
          restingUntil: () => null,
          lift: () => false,
          clear: () => {},
        },
        plan: () => ({
          group: {
            id: 'g1',
            name: 'g',
            members: [
              { providerId: 'p1', modelId: 'm1' },
              { providerId: 'p2', modelId: 'm2' },
            ],
            strategy: 'ordered',
            affinity: 'off',
            createdAt: 1,
          },
          conversationKey: null,
          candidates: [
            {
              seat: 'p1\u241fm1',
              providerId: 'p1',
              modelId: 'm1',
              outboundFormat: 'anthropic',
              upstreamBaseUrl: 'https://a.example',
            },
            {
              seat: 'p2\u241fm2',
              providerId: 'p2',
              modelId: 'm2',
              outboundFormat: 'anthropic',
              upstreamBaseUrl: 'https://b.example',
            },
          ],
        }),
        onFailover: (seat) => resting.push(seat),
        onSuccess: (_g, _k, seat) => successes.push(seat),
        clearGroup: () => {},
        recordDecision: (d) => decisions.push(d),
      },
    });
    started.push(proxy);
    await proxy.start();
    const { token } = proxy.registerRoute(
      spec({
        providerId: '__aiopt_rg__g1',
        modelId: '__route__',
        routingGroupId: 'g1',
        upstreamBaseUrl: 'https://placeholder.example',
      }),
    );
    const res = await fetch(`http://127.0.0.1:${proxy.getPort()}/${token}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: '__route__',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(sentUrls[0]).toContain('a.example');
    expect(sentUrls[1]).toContain('b.example');
    expect(resting).toEqual(['p1\u241fm1']);
    expect(successes).toEqual(['p2\u241fm2']);
    // One decision with the full failover trail — ids / status / ms only.
    expect(decisions).toHaveLength(1);
    const d = decisions[0]!;
    expect(d).toMatchObject({ groupId: 'g1', strategy: 'ordered', sticky: false, ok: true });
    expect(d.attempts.map((a) => [a.providerId, a.modelId, a.status, a.ok])).toEqual([
      ['p1', 'm1', 503, false],
      ['p2', 'm2', 200, true],
    ]);
    expect(Object.keys(d.attempts[0]!).sort()).toEqual(['modelId', 'ms', 'ok', 'providerId', 'status']);
    expect(JSON.stringify(d)).not.toContain('busy');
  });
});
