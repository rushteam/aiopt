import { describe, expect, it, vi } from 'vitest';
import { createProviderManager, providerSecretKey } from '../providerManager';
import { createProviderStore } from '../providerStore';
import type { AgentAdapter, WriteLiveInput } from '../adapters/agentAdapter';
import type { FetchLike } from '../modelCatalog';
import type { TranslationProxy } from '../../proxy/translationProxy';
import type { RouteSpec } from '../../proxy/router';
import type { AgentId, ApiFormat } from '../../../shared/aiProviders';
import { getAgentDef } from '../../../shared/aiProviders';
import type { SecretStore } from '../../secrets/secretStore';
import type { ProvidersSnapshot } from '../../../shared/ipc-channels';
import { decodeIpcError, isIpcError } from '../../../shared/ipc-errors';

function memorySecrets(): SecretStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    isAvailable: () => true,
    set: (k, v) => void raw.set(k, v),
    get: (k) => raw.get(k) ?? null,
    has: (k) => raw.has(k),
    delete: (k) => void raw.delete(k),
  };
}

/** A fake adapter that records writeLive/restoreDefault calls instead of touching disk. */
function fakeAdapter(id: AgentId, installed = true) {
  const calls: WriteLiveInput[] = [];
  let restores = 0;
  const adapter: AgentAdapter = {
    def: getAgentDef(id)!,
    configPaths: () => [`/fake/${id}`],
    detectInstalled: () => installed,
    writeLive: (input) => {
      calls.push(input);
    },
    restoreDefault: () => {
      restores += 1;
    },
  };
  return { adapter, calls, restoreCount: () => restores };
}

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (isIpcError(err)) return err.code;
    if (err instanceof Error) return decodeIpcError(err.message).code;
  }
  throw new Error('expected the call to throw a coded error');
}

/**
 * A fake translation proxy that records register/unregister calls instead of opening
 * a socket. Cross-format setBinding tests assert against `registered`/`unregistered`.
 */
function fakeProxy() {
  const registered: RouteSpec[] = [];
  const unregistered: AgentId[] = [];
  // Track the live route per agent so isRouted/endpointFor mirror the real proxy.
  const live = new Map<AgentId, ReturnType<TranslationProxy['endpointFor']>>();
  let counter = 0;
  // A mutable port so rebindPort can move it and the snapshot's proxyPort reflects the change.
  let port = 4567;
  const proxy: TranslationProxy = {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    getPort: () => port,
    rebindPort: () => {
      // Real proxy binds a fresh OS-assigned port but keeps every route/token intact — only
      // the port segment of each live baseUrl moves. Mirror the port move; the subsequent
      // rebuildRoutes replay re-registers each binding against the new port.
      port += 1;
      return Promise.resolve(port);
    },
    registerRoute: (spec) => {
      registered.push(spec);
      const token = `tok-${++counter}`;
      const baseUrl = `http://127.0.0.1:${port}/${token}`;
      live.set(spec.agentId, { baseUrl, token, modelId: spec.modelId, inboundFormat: spec.inboundFormat });
      return { baseUrl, token };
    },
    unregisterRoute: ({ agentId }) => {
      unregistered.push(agentId);
      live.delete(agentId);
    },
    isRouted: (agentId) => live.has(agentId),
    endpointFor: (agentId) => live.get(agentId) ?? null,
  };
  return { proxy, registered, unregistered };
}

function harness(
  installedAgents: AgentId[] = ['claude'],
  opts: { fetchImpl?: FetchLike; proxyMode?: boolean } = {},
) {
  const store = createProviderStore({ load: () => ({}), save: () => {} });
  const secrets = memorySecrets();
  const adapters = new Map<AgentId, AgentAdapter>();
  const calls: Record<string, WriteLiveInput[]> = {};
  const restoreCounts: Record<string, () => number> = {};
  for (const id of installedAgents) {
    const { adapter, calls: c, restoreCount } = fakeAdapter(id);
    adapters.set(id, adapter);
    calls[id] = c;
    restoreCounts[id] = restoreCount;
  }
  const onChange = vi.fn<(snapshot: ProvidersSnapshot) => void>();
  const { proxy, registered, unregistered } = fakeProxy();
  // Records every string handed to the injected clipboard so copyProxyConfig tests can
  // assert what was written — the real one is Electron's clipboard (main-only).
  const clipboard: string[] = [];
  // Default proxy mode OFF — the product default: same-format bindings connect direct.
  // Tests that exercise the proxied passthrough path pass `{ proxyMode: true }`.
  const manager = createProviderManager(
    store,
    secrets,
    adapters,
    onChange,
    () => proxy,
    () => opts.proxyMode ?? false,
    opts.fetchImpl,
    (text) => clipboard.push(text),
  );
  return { store, secrets, adapters, calls, restoreCounts, onChange, manager, registered, unregistered, clipboard };
}

/** A fake transport that records request headers and returns one openai model. */
function recordingFetch(): { fetchImpl: FetchLike; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [{ id: 'm-a' }] }) });
  };
  return { fetchImpl, calls };
}

function addProvider(
  manager: ReturnType<typeof harness>['manager'],
  overrides: Partial<{ apiFormat: ApiFormat; apiKey: string; modelId: string }> = {},
): string {
  const snap = manager.addProvider({
    name: 'Provider',
    apiFormat: overrides.apiFormat ?? 'anthropic',
    baseUrl: 'https://api.example.com',
    models: [{ id: overrides.modelId ?? 'm1' }],
    notes: undefined,
    apiKey: overrides.apiKey,
  });
  return snap.providers[snap.providers.length - 1]!.id;
}

describe('provider manager — provider CRUD', () => {
  it('addProvider stores the key in secrets and surfaces only hasKey', () => {
    const { manager, secrets } = harness();
    const id = addProvider(manager, { apiKey: 'sk-secret' });
    expect(secrets.raw.get(providerSecretKey(id))).toBe('sk-secret');

    const snap = manager.getSnapshot();
    const summary = snap.providers.find((p) => p.id === id)!;
    expect(summary.hasKey).toBe(true);
    // The plaintext key must never appear anywhere in the snapshot.
    expect(JSON.stringify(snap)).not.toContain('sk-secret');
  });

  it('addProvider without a key sets hasKey false and stores nothing', () => {
    const { manager, secrets } = harness();
    const id = addProvider(manager);
    expect(secrets.raw.size).toBe(0);
    expect(manager.getSnapshot().providers.find((p) => p.id === id)!.hasKey).toBe(false);
  });

  it('updateProvider: null clears the key, a string replaces it', () => {
    const { manager, secrets } = harness();
    const id = addProvider(manager, { apiKey: 'sk-1' });

    manager.updateProvider({ id, apiKey: 'sk-2' });
    expect(secrets.raw.get(providerSecretKey(id))).toBe('sk-2');

    manager.updateProvider({ id, apiKey: null });
    expect(secrets.raw.has(providerSecretKey(id))).toBe(false);
  });

  it('updateProvider: omitted apiKey leaves the stored key untouched', () => {
    const { manager, secrets } = harness();
    const id = addProvider(manager, { apiKey: 'sk-keep' });
    manager.updateProvider({ id, name: 'Renamed' });
    expect(secrets.raw.get(providerSecretKey(id))).toBe('sk-keep');
    expect(manager.getSnapshot().providers.find((p) => p.id === id)!.name).toBe('Renamed');
  });

  it('updateProvider on an unknown id throws NOT_FOUND', () => {
    const { manager } = harness();
    expect(codeOf(() => manager.updateProvider({ id: 'ghost', name: 'x' }))).toBe('NOT_FOUND');
  });

  it('removeProvider deletes the stored key', () => {
    const { manager, secrets } = harness();
    const id = addProvider(manager, { apiKey: 'sk-secret' });
    manager.removeProvider(id);
    expect(secrets.raw.size).toBe(0);
    expect(manager.getSnapshot().providers).toHaveLength(0);
  });

  it('removeProvider on an unknown id throws NOT_FOUND', () => {
    const { manager } = harness();
    expect(codeOf(() => manager.removeProvider('ghost'))).toBe('NOT_FOUND');
  });

  it('every mutation notifies onChange', () => {
    const { manager, onChange } = harness();
    const id = addProvider(manager, { apiKey: 'sk' });
    manager.updateProvider({ id, name: 'x' });
    manager.removeProvider(id);
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});

describe('provider manager — snapshot agents', () => {
  it('reports install status from the adapter and no adapter as not-installed', () => {
    const { manager } = harness(['claude']);
    const agents = manager.getSnapshot().agents;
    expect(agents.find((a) => a.id === 'claude')!.installed).toBe(true);
    expect(agents.find((a) => a.id === 'codex')!.installed).toBe(false);
  });
});

describe('provider manager — setBinding (the apply flow)', () => {
  it('default (proxy mode off): writes the provider into the agent config with the plaintext key (direct)', () => {
    const { manager, calls } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'anthropic', apiKey: 'sk-live', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');

    expect(calls.claude!).toHaveLength(1);
    expect(calls.claude![0]!.apiKey).toBe('sk-live'); // plaintext read main-side
    expect(calls.claude![0]!.modelId).toBe('m1');
    expect(calls.claude![0]!.provider.id).toBe(id);
    expect(manager.getSnapshot().agents.find((a) => a.id === 'claude')!.binding).toEqual({
      providerId: id,
      modelId: 'm1',
    });
  });

  it('default (proxy mode off): writes a model alias (not the id) to the agent, but keeps the id in the binding', () => {
    const { manager, calls } = harness(['claude']);
    const snap = manager.addProvider({
      name: 'Gateway',
      apiFormat: 'anthropic',
      baseUrl: 'https://gw.example.com',
      models: [{ id: 'claude-real', alias: 'my-claude' }],
      notes: undefined,
      apiKey: 'sk',
    });
    const id = snap.providers[snap.providers.length - 1]!.id;
    manager.setBinding('claude', id, 'claude-real');

    // The agent config receives the alias…
    expect(calls.claude![0]!.modelId).toBe('my-claude');
    // …while the stored binding still references the canonical id.
    expect(manager.getSnapshot().agents.find((a) => a.id === 'claude')!.binding).toEqual({
      providerId: id,
      modelId: 'claude-real',
    });
  });

  it('default (proxy mode off): passes a null key through when the provider has none stored', () => {
    const { manager, calls } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'anthropic', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');
    expect(calls.claude![0]!.apiKey).toBeNull();
  });

  it('rejects binding an agent that has no adapter with UNSUPPORTED_CAPABILITY', () => {
    const { manager } = harness(['claude']); // no codex adapter registered
    const id = addProvider(manager, { apiFormat: 'openai', apiKey: 'sk', modelId: 'm1' });
    // codex→openai is a translatable cross-format pair — it fails only on the missing adapter
    // (the adapter check in applyBinding runs before the format check).
    expect(codeOf(() => manager.setBinding('codex', id, 'm1'))).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('rejects an unknown provider or model with NOT_FOUND', () => {
    const { manager } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'anthropic', modelId: 'm1' });
    expect(codeOf(() => manager.setBinding('claude', 'ghost', 'm1'))).toBe('NOT_FOUND');
    expect(codeOf(() => manager.setBinding('claude', id, 'no-such-model'))).toBe('NOT_FOUND');
  });

  it('clearBinding removes the binding without writing to the adapter', () => {
    const { manager, calls } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'anthropic', apiKey: 'sk', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');
    manager.clearBinding('claude');
    expect(manager.getSnapshot().agents.find((a) => a.id === 'claude')!.binding).toBeNull();
    expect(calls.claude!).toHaveLength(1); // only the setBinding write, none on clear
  });

  it('default (proxy mode off): a same-format binding registers NO route (direct connection)', () => {
    const { manager, registered } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'anthropic', apiKey: 'sk-live', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');
    expect(registered).toHaveLength(0);
  });

  it('proxy mode: a same-format binding routes through the proxy (passthrough) and hides the key', () => {
    const { manager, registered, calls } = harness(['claude'], { proxyMode: true });
    const id = addProvider(manager, { apiFormat: 'anthropic', apiKey: 'sk-REAL-secret', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');

    // A same-format identity route: inbound === outbound.
    expect(registered).toHaveLength(1);
    expect(registered[0]!).toMatchObject({
      agentId: 'claude',
      inboundFormat: 'anthropic',
      outboundFormat: 'anthropic',
      upstreamBaseUrl: 'https://api.example.com',
      modelId: 'm1',
    });
    // The agent config gets the loopback token, never the real key.
    const write = calls.claude![0]!;
    expect(write.provider.baseUrl).toBe('http://127.0.0.1:4567/tok-1');
    expect(write.apiKey).toBe('tok-1');
    expect(JSON.stringify(write)).not.toContain('sk-REAL-secret');
  });

  it('proxy mode: a same-format GEMINI binding stays direct (no proxy dialect for gemini)', () => {
    const { manager, registered, calls } = harness(['gemini'], { proxyMode: true });
    const id = addProvider(manager, { apiFormat: 'gemini', apiKey: 'sk-gem', modelId: 'm1' });
    manager.setBinding('gemini', id, 'm1');
    // Gemini can't be proxied, so even with proxy mode on it is written direct.
    expect(registered).toHaveLength(0);
    expect(calls.gemini![0]!.apiKey).toBe('sk-gem');
  });
});

describe('provider manager — setBinding cross-format (translation proxy)', () => {
  it('registers a route with the right in/out formats + upstream base, and writes the token (never the real key)', () => {
    const { manager, calls, registered } = harness(['claude']);
    // Claude speaks anthropic; bind it to an OpenAI-format provider → translation route.
    const id = addProvider(manager, { apiFormat: 'openai', apiKey: 'sk-REAL-secret', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');

    expect(registered).toHaveLength(1);
    const route = registered[0]!;
    expect(route).toMatchObject({
      agentId: 'claude',
      providerId: id,
      inboundFormat: 'anthropic',
      outboundFormat: 'openai',
      upstreamBaseUrl: 'https://api.example.com',
      modelId: 'm1',
    });

    // The agent config gets the loopback URL + the per-binding token, NOT the real key.
    expect(calls.claude!).toHaveLength(1);
    const write = calls.claude![0]!;
    expect(write.provider.baseUrl).toBe('http://127.0.0.1:4567/tok-1');
    expect(write.apiKey).toBe('tok-1');
    // The real key must never reach the adapter write.
    expect(JSON.stringify(write)).not.toContain('sk-REAL-secret');
  });

  it('rejects a gemini provider (untranslatable) with UNSUPPORTED_CAPABILITY and registers nothing', () => {
    const { manager, registered, calls } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'gemini', apiKey: 'sk', modelId: 'm1' });
    expect(codeOf(() => manager.setBinding('claude', id, 'm1'))).toBe('UNSUPPORTED_CAPABILITY');
    expect(registered).toHaveLength(0);
    expect(calls.claude!).toHaveLength(0);
    expect(manager.getSnapshot().agents.find((a) => a.id === 'claude')!.binding).toBeNull();
  });

  it('codex (Responses) → OpenAI Chat provider registers a route with the right in/out formats', () => {
    const { manager, calls, registered } = harness(['codex']);
    const id = addProvider(manager, { apiFormat: 'openai', apiKey: 'sk-REAL', modelId: 'm1' });
    manager.setBinding('codex', id, 'm1');

    expect(registered).toHaveLength(1);
    expect(registered[0]!).toMatchObject({
      agentId: 'codex',
      providerId: id,
      inboundFormat: 'openai-responses',
      outboundFormat: 'openai',
      modelId: 'm1',
    });
    // The agent config gets the loopback token, never the real key.
    expect(calls.codex![0]!.apiKey).toBe('tok-1');
    expect(JSON.stringify(calls.codex![0]!)).not.toContain('sk-REAL');
  });

  it('codex (Responses) → Anthropic provider registers a route (reasoning-bridge direction)', () => {
    const { manager, registered } = harness(['codex']);
    const id = addProvider(manager, { apiFormat: 'anthropic', apiKey: 'sk', modelId: 'm1' });
    manager.setBinding('codex', id, 'm1');

    expect(registered).toHaveLength(1);
    expect(registered[0]!).toMatchObject({
      agentId: 'codex',
      inboundFormat: 'openai-responses',
      outboundFormat: 'anthropic',
    });
  });

  it('rejects codex → gemini provider (untranslatable) with UNSUPPORTED_CAPABILITY', () => {
    const { manager, registered } = harness(['codex']);
    const id = addProvider(manager, { apiFormat: 'gemini', apiKey: 'sk', modelId: 'm1' });
    expect(codeOf(() => manager.setBinding('codex', id, 'm1'))).toBe('UNSUPPORTED_CAPABILITY');
    expect(registered).toHaveLength(0);
  });

  it('clearBinding unregisters the cross-format route', () => {
    const { manager, unregistered } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'openai', apiKey: 'sk', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');
    manager.clearBinding('claude');
    expect(unregistered).toContain('claude');
  });

  it('restoreAgentDefault unregisters the cross-format route', () => {
    const { manager, unregistered } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'openai', apiKey: 'sk', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');
    manager.restoreAgentDefault('claude');
    expect(unregistered).toContain('claude');
  });

  it('removeProvider unregisters the route of any agent bound to it', () => {
    const { manager, unregistered } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'openai', apiKey: 'sk', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');
    manager.removeProvider(id);
    expect(unregistered).toContain('claude');
  });
});

describe('provider manager — copyProxyConfig', () => {
  it('rejects an unknown agent id with INVALID_PARAMS', () => {
    const { manager } = harness(['claude']);
    expect(codeOf(() => manager.copyProxyConfig('nope' as AgentId))).toBe('INVALID_PARAMS');
  });

  it('returns { copied: false } and writes nothing when the agent has no live route', () => {
    const { manager, clipboard } = harness(['claude']);
    // A direct (same-format, proxy mode off) binding registers no route.
    const id = addProvider(manager, { apiFormat: 'anthropic', apiKey: 'sk', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');
    expect(manager.copyProxyConfig('claude')).toEqual({ copied: false });
    expect(clipboard).toHaveLength(0);
  });

  it('writes an anthropic-dialect snippet (base URL + token + model) for a proxied claude route', () => {
    const { manager, clipboard } = harness(['claude']);
    // Claude (anthropic inbound) bound to an OpenAI provider → a live translation route.
    const id = addProvider(manager, { apiFormat: 'openai', apiKey: 'sk-REAL-secret', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');

    expect(manager.copyProxyConfig('claude')).toEqual({ copied: true });
    expect(clipboard).toHaveLength(1);
    const snippet = clipboard[0]!;
    expect(snippet).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:4567/tok-1');
    expect(snippet).toContain('ANTHROPIC_API_KEY=tok-1');
    expect(snippet).toContain('MODEL=m1');
    // The upstream provider's real key must never appear in the copied snippet.
    expect(snippet).not.toContain('sk-REAL-secret');
  });

  it('uses OpenAI env var names for an openai-inbound route', () => {
    const { manager, clipboard } = harness(['codex']);
    // Codex (openai-responses inbound) → Anthropic provider serves the OpenAI Responses path.
    const id = addProvider(manager, { apiFormat: 'anthropic', apiKey: 'sk', modelId: 'm1' });
    manager.setBinding('codex', id, 'm1');

    expect(manager.copyProxyConfig('codex')).toEqual({ copied: true });
    expect(clipboard[0]!).toContain('OPENAI_BASE_URL=');
    expect(clipboard[0]!).toContain('OPENAI_API_KEY=tok-1');
  });
});

describe('provider manager — snapshot proxied flag', () => {
  it('tracks the live route state of each agent', () => {
    const { manager } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'openai', apiKey: 'sk', modelId: 'm1' });

    const before = manager.getSnapshot().agents.find((a) => a.id === 'claude')!;
    expect(before.proxied).toBe(false);

    manager.setBinding('claude', id, 'm1'); // cross-format → routed
    expect(manager.getSnapshot().agents.find((a) => a.id === 'claude')!.proxied).toBe(true);

    manager.clearBinding('claude');
    expect(manager.getSnapshot().agents.find((a) => a.id === 'claude')!.proxied).toBe(false);
  });
});

describe('provider manager — refreshProxyPort', () => {
  it('rebinds to a fresh port and re-syncs every proxied agent to it', async () => {
    const { manager, calls, registered } = harness(['claude']);
    // Cross-format binding → a live proxy route on the initial port (4567).
    const id = addProvider(manager, { apiFormat: 'openai', apiKey: 'sk', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');
    expect(registered).toHaveLength(1);
    expect(calls.claude![0]!.provider.baseUrl).toBe('http://127.0.0.1:4567/tok-1');

    const { port } = await manager.refreshProxyPort();
    // The port moved off the collided one…
    expect(port).toBe(4568);
    // …and the binding was replayed, rewriting the on-disk baseUrl to the new port.
    expect(registered).toHaveLength(2);
    expect(calls.claude![calls.claude!.length - 1]!.provider.baseUrl).toBe('http://127.0.0.1:4568/tok-2');
  });

  it('reports the new port in the snapshot and broadcasts it', async () => {
    const { manager, onChange } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'openai', apiKey: 'sk', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');
    onChange.mockClear();

    await manager.refreshProxyPort();
    expect(manager.getSnapshot().proxyPort).toBe(4568);
    // The fresh snapshot is pushed to every window.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]!.proxyPort).toBe(4568);
  });

  it('is a no-op replay for a direct binding (nothing to re-sync)', async () => {
    const { manager, registered } = harness(['claude']);
    // Same-format, proxy mode off → direct, no route.
    const id = addProvider(manager, { apiFormat: 'anthropic', apiKey: 'sk', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');

    const { port } = await manager.refreshProxyPort();
    expect(port).toBe(4568);
    expect(registered).toHaveLength(0);
  });
});

describe('provider manager — snapshot proxyPort', () => {
  it('surfaces the live loopback port from the proxy', () => {
    const { manager } = harness(['claude']);
    // The fake proxy reports 4567 from the start (a real one binds during app start).
    expect(manager.getSnapshot().proxyPort).toBe(4567);
  });
});

describe('provider manager — restoreAgentDefault', () => {
  it('restores the agent config via its adapter and clears the binding', () => {
    const { manager, calls, restoreCounts } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'anthropic', apiKey: 'sk', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');
    expect(calls.claude!).toHaveLength(1);

    const snap = manager.restoreAgentDefault('claude');
    expect(restoreCounts.claude!()).toBe(1);
    expect(snap.agents.find((a) => a.id === 'claude')!.binding).toBeNull();
  });

  it('leaves the provider pool and its stored key untouched', () => {
    const { manager, secrets } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'anthropic', apiKey: 'sk-keep', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');

    manager.restoreAgentDefault('claude');
    expect(manager.getSnapshot().providers.find((p) => p.id === id)).toBeTruthy();
    expect(secrets.raw.get(providerSecretKey(id))).toBe('sk-keep');
  });

  it('works with no active binding (a plain undo of the config file)', () => {
    const { manager, restoreCounts } = harness(['claude']);
    const snap = manager.restoreAgentDefault('claude');
    expect(restoreCounts.claude!()).toBe(1);
    expect(snap.agents.find((a) => a.id === 'claude')!.binding).toBeNull();
  });

  it('throws UNSUPPORTED_CAPABILITY for an agent with no adapter', () => {
    const { manager } = harness(['claude']); // no codex adapter registered
    expect(codeOf(() => manager.restoreAgentDefault('codex'))).toBe('UNSUPPORTED_CAPABILITY');
  });
});

describe('provider manager — revealKey (gated plaintext read)', () => {
  it('returns the stored plaintext for an existing provider', () => {
    const { manager } = harness();
    const id = addProvider(manager, { apiKey: 'sk-reveal' });
    expect(manager.revealKey(id)).toBe('sk-reveal');
  });

  it('returns null when the provider has no key stored', () => {
    const { manager } = harness();
    const id = addProvider(manager);
    expect(manager.revealKey(id)).toBeNull();
  });

  it('throws NOT_FOUND for an unknown provider', () => {
    const { manager } = harness();
    expect(codeOf(() => manager.revealKey('ghost'))).toBe('NOT_FOUND');
  });
});

describe('provider manager — resolveUpstreamKey (main-side plaintext for the proxy)', () => {
  it('returns the stored plaintext key', () => {
    const { manager } = harness();
    const id = addProvider(manager, { apiKey: 'sk-upstream' });
    expect(manager.resolveUpstreamKey(id)).toBe('sk-upstream');
  });

  it('returns null when no key is stored (unknown id included — no throw)', () => {
    const { manager } = harness();
    const id = addProvider(manager);
    expect(manager.resolveUpstreamKey(id)).toBeNull();
    expect(manager.resolveUpstreamKey('ghost')).toBeNull();
  });
});

describe('provider manager — rebuildProxyRoutes (startup route refresh)', () => {
  it('re-registers cross-format routes and refreshes the on-disk config', () => {
    const { manager, registered, calls } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'openai', apiKey: 'sk', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');
    expect(registered).toHaveLength(1);

    manager.rebuildProxyRoutes();
    // A fresh route (rotated token) plus a fresh config write.
    expect(registered).toHaveLength(2);
    expect(calls.claude![calls.claude!.length - 1]!.apiKey).toBe('tok-2');
  });

  it('default (proxy mode off): skips same-format bindings (direct, no route to rebuild)', () => {
    const { manager, registered } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'anthropic', apiKey: 'sk', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');
    manager.rebuildProxyRoutes();
    expect(registered).toHaveLength(0);
  });

  it('proxy mode: re-registers a same-format passthrough route with a rotated token', () => {
    const { manager, registered, calls } = harness(['claude'], { proxyMode: true });
    const id = addProvider(manager, { apiFormat: 'anthropic', apiKey: 'sk', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');
    expect(registered).toHaveLength(1);

    manager.rebuildProxyRoutes();
    expect(registered).toHaveLength(2); // rotated
    expect(calls.claude![calls.claude!.length - 1]!.apiKey).toBe('tok-2');
  });
});

describe('provider manager — fetchModels (key resolution)', () => {
  it('prefers a freshly-typed key over the stored one', async () => {
    const { fetchImpl, calls } = recordingFetch();
    const { manager } = harness(['claude'], { fetchImpl });
    const id = addProvider(manager, { apiFormat: 'openai', apiKey: 'stored-key' });

    const models = await manager.fetchModels({
      apiFormat: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'typed-key',
      providerId: id,
    });

    expect(calls[0]!.headers.authorization).toBe('Bearer typed-key');
    expect(models).toEqual([{ id: 'm-a' }]);
  });

  it('falls back to the stored key when the field is blank (edit mode)', async () => {
    const { fetchImpl, calls } = recordingFetch();
    const { manager } = harness(['claude'], { fetchImpl });
    const id = addProvider(manager, { apiFormat: 'openai', apiKey: 'stored-key' });

    await manager.fetchModels({
      apiFormat: 'openai',
      baseUrl: 'https://api.example.com/v1',
      providerId: id,
    });

    expect(calls[0]!.headers.authorization).toBe('Bearer stored-key');
  });

  it('sends no key when neither a typed key nor a stored provider key exists', async () => {
    const { fetchImpl, calls } = recordingFetch();
    const { manager } = harness(['claude'], { fetchImpl });

    await manager.fetchModels({ apiFormat: 'openai', baseUrl: 'https://api.example.com/v1' });

    expect(calls[0]!.headers.authorization).toBeUndefined();
  });
});
