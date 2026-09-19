import { describe, expect, it } from 'vitest';
import {
  createInMemoryRegistry,
  type InMemoryIpcRegistry,
  type IpcInvokeMeta,
} from '../../ipc/registry';
import { throwIpcError } from '../../ipc/validate';
import { registerProviderIpc } from '../providerIpc';
import { createProviderManager } from '../providerManager';
import { createProviderStore } from '../providerStore';
import type { AgentAdapter } from '../adapters/agentAdapter';
import type { FetchLike } from '../modelCatalog';
import type { TranslationProxy } from '../../proxy/translationProxy';
import type { AgentId } from '../../../shared/aiProviders';
import { getAgentDef } from '../../../shared/aiProviders';
import type { SecretStore } from '../../secrets/secretStore';
import { IPC_CHANNELS, type ProvidersSnapshot } from '../../../shared/ipc-channels';
import { decodeIpcError, isIpcError, type IpcErrorCode } from '../../../shared/ipc-errors';

const trusted: IpcInvokeMeta = { assertTrustedSender: () => {} };
const untrusted: IpcInvokeMeta = {
  assertTrustedSender: () => throwIpcError('PERMISSION_DENIED', 'nope'),
};

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

function fakeClaudeAdapter() {
  const written: unknown[] = [];
  let restores = 0;
  const adapter: AgentAdapter = {
    def: getAgentDef('claude')!,
    configPaths: () => ['/fake/claude'],
    detectInstalled: () => true,
    writeLive: (input) => void written.push(input),
    restoreDefault: () => void (restores += 1),
  };
  return { adapter, written, restoreCount: () => restores };
}

function harness(fetchImpl?: FetchLike): {
  reg: InMemoryIpcRegistry;
  secrets: ReturnType<typeof memorySecrets>;
} {
  const reg = createInMemoryRegistry();
  const secrets = memorySecrets();
  const store = createProviderStore({ load: () => ({}), save: () => {} });
  const adapters = new Map<AgentId, AgentAdapter>([['claude', fakeClaudeAdapter().adapter]]);
  // Minimal proxy stub — these tests exercise same-format bindings only, so it is never
  // asked to register a route.
  const proxy: TranslationProxy = {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    getPort: () => 4567,
    rebindPort: () => Promise.resolve(4568),
    registerRoute: () => ({ baseUrl: 'http://127.0.0.1:4567/tok', token: 'tok' }),
    unregisterRoute: () => {},
    isRouted: () => false,
    endpointFor: () => null,
  };
  // Proxy mode off (the default): these tests exercise same-format bindings and assume a
  // direct config (the proxy stub above is never asked to register a route).
  const manager = createProviderManager(store, secrets, adapters, () => {}, () => proxy, () => false, fetchImpl);
  registerProviderIpc(reg, manager);
  return { reg, secrets };
}

async function codeOf(fn: () => Promise<unknown>): Promise<IpcErrorCode> {
  try {
    await fn();
  } catch (err) {
    if (isIpcError(err)) return err.code;
    if (err instanceof Error) return decodeIpcError(err.message).code;
  }
  throw new Error('expected the invocation to throw');
}

const addPayload = {
  name: 'Anthropic',
  apiFormat: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  models: [{ id: 'claude-x' }],
  apiKey: 'sk-secret',
};

describe('provider IPC — authorization', () => {
  it('list returns a snapshot for a trusted sender', async () => {
    const { reg } = harness();
    const snap = (await reg.invoke(IPC_CHANNELS.providersList, undefined, trusted)) as ProvidersSnapshot;
    expect(snap.providers).toEqual([]);
    expect(snap.agents.map((a) => a.id)).toContain('claude');
  });

  it('rejects an untrusted call with PERMISSION_DENIED and stores nothing', async () => {
    const { reg, secrets } = harness();
    expect(await codeOf(() => reg.invoke(IPC_CHANNELS.providersAdd, addPayload, untrusted))).toBe(
      'PERMISSION_DENIED',
    );
    expect(secrets.raw.size).toBe(0);
  });
});

describe('provider IPC — payload validation', () => {
  it('rejects add with a bad apiFormat (INVALID_PARAMS)', async () => {
    const { reg } = harness();
    expect(
      await codeOf(() =>
        reg.invoke(IPC_CHANNELS.providersAdd, { ...addPayload, apiFormat: 'nope' }, trusted),
      ),
    ).toBe('INVALID_PARAMS');
  });

  it('rejects add with an empty models array (INVALID_PARAMS)', async () => {
    const { reg } = harness();
    expect(
      await codeOf(() => reg.invoke(IPC_CHANNELS.providersAdd, { ...addPayload, models: [] }, trusted)),
    ).toBe('INVALID_PARAMS');
  });

  it('rejects setBinding with an unknown agentId (INVALID_PARAMS)', async () => {
    const { reg } = harness();
    expect(
      await codeOf(() =>
        reg.invoke(
          IPC_CHANNELS.providersSetBinding,
          { agentId: 'nope', providerId: 'p', modelId: 'm' },
          trusted,
        ),
      ),
    ).toBe('INVALID_PARAMS');
  });
});

describe('provider IPC — flows never leak the key', () => {
  it('add returns a snapshot with hasKey and no plaintext', async () => {
    const { reg, secrets } = harness();
    const snap = (await reg.invoke(IPC_CHANNELS.providersAdd, addPayload, trusted)) as ProvidersSnapshot;
    expect(snap.providers).toHaveLength(1);
    expect(snap.providers[0]!.hasKey).toBe(true);
    expect(JSON.stringify(snap)).not.toContain('sk-secret');
    // The key really was stored (just not returned).
    expect([...secrets.raw.values()]).toContain('sk-secret');
  });

  it('setBinding a compatible provider succeeds and records the binding', async () => {
    const { reg } = harness();
    const added = (await reg.invoke(IPC_CHANNELS.providersAdd, addPayload, trusted)) as ProvidersSnapshot;
    const id = added.providers[0]!.id;
    const snap = (await reg.invoke(
      IPC_CHANNELS.providersSetBinding,
      { agentId: 'claude', providerId: id, modelId: 'claude-x' },
      trusted,
    )) as ProvidersSnapshot;
    expect(snap.agents.find((a) => a.id === 'claude')!.binding).toEqual({
      providerId: id,
      modelId: 'claude-x',
    });
  });
});

describe('provider IPC — restoreDefault', () => {
  it('rejects an untrusted call with PERMISSION_DENIED', async () => {
    const { reg } = harness();
    expect(
      await codeOf(() =>
        reg.invoke(IPC_CHANNELS.providersRestoreDefault, { agentId: 'claude' }, untrusted),
      ),
    ).toBe('PERMISSION_DENIED');
  });

  it('rejects a bad agentId with INVALID_PARAMS', async () => {
    const { reg } = harness();
    expect(
      await codeOf(() => reg.invoke(IPC_CHANNELS.providersRestoreDefault, { agentId: 'nope' }, trusted)),
    ).toBe('INVALID_PARAMS');
  });

  it('clears the binding for a trusted call', async () => {
    const { reg } = harness();
    const added = (await reg.invoke(IPC_CHANNELS.providersAdd, addPayload, trusted)) as ProvidersSnapshot;
    const id = added.providers[0]!.id;
    await reg.invoke(
      IPC_CHANNELS.providersSetBinding,
      { agentId: 'claude', providerId: id, modelId: 'claude-x' },
      trusted,
    );
    const snap = (await reg.invoke(
      IPC_CHANNELS.providersRestoreDefault,
      { agentId: 'claude' },
      trusted,
    )) as ProvidersSnapshot;
    expect(snap.agents.find((a) => a.id === 'claude')!.binding).toBeNull();
  });
});

describe('provider IPC — revealKey (gated: returns plaintext by design)', () => {
  it('rejects an untrusted call with PERMISSION_DENIED', async () => {
    const { reg } = harness();
    expect(
      await codeOf(() =>
        reg.invoke(IPC_CHANNELS.providersRevealKey, { providerId: 'p' }, untrusted),
      ),
    ).toBe('PERMISSION_DENIED');
  });

  it('returns the stored plaintext key for a trusted sender', async () => {
    const { reg } = harness();
    const added = (await reg.invoke(IPC_CHANNELS.providersAdd, addPayload, trusted)) as ProvidersSnapshot;
    const id = added.providers[0]!.id;
    const result = (await reg.invoke(
      IPC_CHANNELS.providersRevealKey,
      { providerId: id },
      trusted,
    )) as { key: string | null };
    expect(result.key).toBe('sk-secret');
  });
});

describe('provider IPC — copyProxyConfig', () => {
  it('rejects an untrusted call with PERMISSION_DENIED', async () => {
    const { reg } = harness();
    expect(
      await codeOf(() =>
        reg.invoke(IPC_CHANNELS.providersCopyProxyConfig, { agentId: 'claude' }, untrusted),
      ),
    ).toBe('PERMISSION_DENIED');
  });

  it('rejects a bad agentId with INVALID_PARAMS', async () => {
    const { reg } = harness();
    expect(
      await codeOf(() =>
        reg.invoke(IPC_CHANNELS.providersCopyProxyConfig, { agentId: 'nope' }, trusted),
      ),
    ).toBe('INVALID_PARAMS');
  });

  it('returns { copied: false } for a trusted call when the agent has no live route', async () => {
    const { reg } = harness();
    // The harness proxy stub reports no route (endpointFor → null).
    const result = await reg.invoke(
      IPC_CHANNELS.providersCopyProxyConfig,
      { agentId: 'claude' },
      trusted,
    );
    expect(result).toEqual({ copied: false });
  });
});

describe('provider IPC — refreshProxyPort', () => {
  it('rejects an untrusted call with PERMISSION_DENIED', async () => {
    const { reg } = harness();
    expect(
      await codeOf(() => reg.invoke(IPC_CHANNELS.providersRefreshProxyPort, undefined, untrusted)),
    ).toBe('PERMISSION_DENIED');
  });

  it('returns the fresh port for a trusted call', async () => {
    const { reg } = harness();
    // The harness proxy stub rebinds to 4568.
    const result = (await reg.invoke(
      IPC_CHANNELS.providersRefreshProxyPort,
      undefined,
      trusted,
    )) as { port: number };
    expect(result.port).toBe(4568);
  });
});

describe('provider IPC — fetchModels', () => {
  const fetchPayload = { apiFormat: 'openai', baseUrl: 'https://api.example.com/v1' };

  it('rejects an untrusted fetchModels call with PERMISSION_DENIED', async () => {
    const { reg } = harness();
    expect(
      await codeOf(() => reg.invoke(IPC_CHANNELS.providersFetchModels, fetchPayload, untrusted)),
    ).toBe('PERMISSION_DENIED');
  });

  it('rejects a missing baseUrl (INVALID_PARAMS) before any network call', async () => {
    const { reg } = harness();
    expect(
      await codeOf(() =>
        reg.invoke(IPC_CHANNELS.providersFetchModels, { apiFormat: 'openai' }, trusted),
      ),
    ).toBe('INVALID_PARAMS');
  });

  it('rejects a bad apiFormat (INVALID_PARAMS)', async () => {
    const { reg } = harness();
    expect(
      await codeOf(() =>
        reg.invoke(IPC_CHANNELS.providersFetchModels, { ...fetchPayload, apiFormat: 'nope' }, trusted),
      ),
    ).toBe('INVALID_PARAMS');
  });

  it('returns the discovered models for a trusted call', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [{ id: 'gpt-4o' }] }) });
    const { reg } = harness(fetchImpl);
    const result = (await reg.invoke(
      IPC_CHANNELS.providersFetchModels,
      { ...fetchPayload, apiKey: 'sk-typed' },
      trusted,
    )) as { models: { id: string }[] };
    expect(result.models).toEqual([{ id: 'gpt-4o' }]);
  });
});
