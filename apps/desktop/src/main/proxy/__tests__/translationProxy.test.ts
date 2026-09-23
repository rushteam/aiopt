import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createTranslationProxy, type TranslationProxy } from '../translationProxy';
import type { ProxyStateStore, PersistedRoute } from '../proxyStore';
import type { ProxyFetch } from '../upstream';
import type { RouteSpec } from '../router';

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
