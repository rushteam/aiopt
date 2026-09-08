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
  let counter = 0;
  const proxy: TranslationProxy = {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    getPort: () => 4567,
    registerRoute: (spec) => {
      registered.push(spec);
      const token = `tok-${++counter}`;
      return { baseUrl: `http://127.0.0.1:4567/${token}`, token };
    },
    unregisterRoute: ({ agentId }) => void unregistered.push(agentId),
  };
  return { proxy, registered, unregistered };
}

function harness(installedAgents: AgentId[] = ['claude'], fetchImpl?: FetchLike) {
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
  const manager = createProviderManager(store, secrets, adapters, onChange, () => proxy, fetchImpl);
  return { store, secrets, adapters, calls, restoreCounts, onChange, manager, registered, unregistered };
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
  it('writes the provider into the agent config with the plaintext key', () => {
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

  it('writes a model alias (not the id) to the agent, but keeps the id in the binding', () => {
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

  it('passes a null key through when the provider has none stored', () => {
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

  it('same-format binding registers NO route (direct connection)', () => {
    const { manager, registered } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'anthropic', apiKey: 'sk-live', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');
    expect(registered).toHaveLength(0);
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

  it('skips same-format bindings (no route to rebuild)', () => {
    const { manager, registered } = harness(['claude']);
    const id = addProvider(manager, { apiFormat: 'anthropic', apiKey: 'sk', modelId: 'm1' });
    manager.setBinding('claude', id, 'm1');
    manager.rebuildProxyRoutes();
    expect(registered).toHaveLength(0);
  });
});

describe('provider manager — fetchModels (key resolution)', () => {
  it('prefers a freshly-typed key over the stored one', async () => {
    const { fetchImpl, calls } = recordingFetch();
    const { manager } = harness(['claude'], fetchImpl);
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
    const { manager } = harness(['claude'], fetchImpl);
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
    const { manager } = harness(['claude'], fetchImpl);

    await manager.fetchModels({ apiFormat: 'openai', baseUrl: 'https://api.example.com/v1' });

    expect(calls[0]!.headers.authorization).toBeUndefined();
  });
});
