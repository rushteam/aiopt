// Provider manager — the state machine between the store/secrets/adapters and IPC.
//
// It owns the single safe view of the pool (`ProvidersSnapshot`, with `hasKey`
// instead of any key material) and is the ONLY place a plaintext key is read: at
// bind time it fetches the key main-side and hands it to the adapter to write into
// the agent's config (agents read plaintext — unavoidable). The key never crosses
// back to the renderer. Every mutation notifies `onChange`, wired to a broadcast.

import { randomUUID } from 'node:crypto';
import {
  AGENTS,
  getAgentDef,
  isFormatCompatible,
  translationSupported,
  wireModelName,
  type AgentId,
  type Provider,
  type ProviderModel,
} from '../../shared/aiProviders';
import type {
  ProviderAddRequest,
  ProviderFetchModelsRequest,
  ProviderSummary,
  ProviderUpdateRequest,
  ProvidersSnapshot,
} from '../../shared/ipc-channels';
import { MAIN_ONLY_SECRET_PREFIX, type SecretStore } from '../secrets/secretStore';
import { throwIpcError } from '../ipc/validate';
import { logger } from '../logger';
import type { AgentAdapter } from './adapters/agentAdapter';
import { fetchProviderModels, type FetchLike } from './modelCatalog';
import type { ProviderStore } from './providerStore';
import type { TranslationProxy } from '../proxy/translationProxy';

/** Main-only secret key holding one provider's API key. */
export function providerSecretKey(providerId: string): string {
  return `${MAIN_ONLY_SECRET_PREFIX}provider_${providerId}_key`;
}

export type ProvidersChangeListener = (snapshot: ProvidersSnapshot) => void;

export interface ProviderManager {
  getSnapshot(): ProvidersSnapshot;
  addProvider(input: ProviderAddRequest): ProvidersSnapshot;
  updateProvider(input: ProviderUpdateRequest): ProvidersSnapshot;
  removeProvider(id: string): ProvidersSnapshot;
  setBinding(agentId: AgentId, providerId: string, modelId: string): ProvidersSnapshot;
  clearBinding(agentId: AgentId): ProvidersSnapshot;
  /**
   * Undo AiOpt's takeover of one agent: restore its native config file(s) to their
   * pre-AiOpt state (backup written back, or the AiOpt-created file removed) AND
   * clear the stored binding. The write is delegated to the agent's adapter; the
   * stored API keys in the secret store are untouched.
   */
  restoreAgentDefault(agentId: AgentId): ProvidersSnapshot;
  /** Ask a provider's API for its model list. Read-only: touches neither store nor secrets writes. */
  fetchModels(input: ProviderFetchModelsRequest): Promise<ProviderModel[]>;
  /**
   * GATED: return a provider's stored key in plaintext. This is the one read that
   * hands a secret back to the caller (and ultimately the renderer) by design —
   * see the channel note in ipc-channels.ts. Null when none is stored.
   */
  revealKey(providerId: string): string | null;
  /**
   * Resolve a provider's stored key in plaintext for the translation proxy's OUTBOUND
   * call. Like {@link revealKey} this is a deliberate plaintext read, but the value is
   * used ENTIRELY main-side (placed in the upstream request headers) and never crosses
   * IPC. Keeping it here preserves the invariant that providerManager is the only place
   * a key is read. Null when none is stored.
   */
  resolveUpstreamKey(providerId: string): string | null;
  /**
   * Startup helper: re-register a proxy route and refresh the on-disk config for every
   * cross-format binding. The proxy port is ephemeral and tokens rotate each launch, so
   * the baseUrl+token written last session point at a dead listener — this rewrites them.
   */
  rebuildProxyRoutes(): void;
}

export function createProviderManager(
  store: ProviderStore,
  secrets: SecretStore,
  adapters: Map<AgentId, AgentAdapter>,
  onChange: ProvidersChangeListener,
  // Lazy accessor for the translation proxy. A thunk (not the instance) breaks the
  // construction cycle: the proxy needs this manager's `resolveUpstreamKey`, and the
  // manager needs the proxy to register cross-format routes. Resolved on demand via the
  // existing lazy singleton in services.ts.
  getProxy: () => TranslationProxy,
  // Injected outbound transport for model discovery (Electron `net.fetch` in
  // production; a stub in tests). Defaults to the global fetch as a fallback.
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): ProviderManager {
  function toSummary(provider: Provider): ProviderSummary {
    return {
      id: provider.id,
      name: provider.name,
      apiFormat: provider.apiFormat,
      baseUrl: provider.baseUrl,
      models: provider.models,
      notes: provider.notes,
      createdAt: provider.createdAt,
      hasKey: secrets.has(providerSecretKey(provider.id)),
    };
  }

  function snapshot(): ProvidersSnapshot {
    return {
      providers: store.listProviders().map(toSummary),
      agents: AGENTS.map((def) => ({
        id: def.id,
        name: def.name,
        acceptedFormats: def.acceptedFormats,
        mode: def.mode,
        installed: adapters.get(def.id)?.detectInstalled() ?? false,
        binding: store.getBinding(def.id),
      })),
    };
  }

  function announce(): ProvidersSnapshot {
    const next = snapshot();
    onChange(next);
    return next;
  }

  /**
   * Point one agent at a provider+model: write the agent's native config and, for a
   * cross-format pairing, register the translation route. Shared by `setBinding` (fresh
   * user action) and `rebuildProxyRoutes` (startup). Does NOT touch the binding store —
   * callers own that. Throws coded errors for unbindable pairings.
   */
  function applyBinding(agentId: AgentId, provider: Provider, model: ProviderModel): void {
    const def = getAgentDef(agentId);
    if (!def) throwIpcError('INVALID_PARAMS', 'unknown agent');
    const adapter = adapters.get(agentId);
    if (!adapter) throwIpcError('UNSUPPORTED_CAPABILITY', 'no adapter for this agent yet');

    // The binding references the canonical model id, but the agent config receives the
    // alias when one is set (a gateway's / shortened outward name); otherwise the id.
    const wireModelId = wireModelName(model);

    if (isFormatCompatible(def, provider)) {
      // Same-format: direct config with the real key, no proxy. Drop any stale route
      // left by a previous cross-format binding for this agent.
      getProxy().unregisterRoute({ agentId });
      const apiKey = secrets.get(providerSecretKey(provider.id));
      adapter.writeLive({ provider, modelId: wireModelId, apiKey });
      return;
    }

    // Cross-format: the proxy translates a bounded set of directed format pairs
    // (see translationSupported) — Anthropic ⇄ Chat Completions, and Responses (codex/
    // grok) → Chat Completions / Anthropic. Any other pairing is refused here.
    const inbound = def.acceptedFormats[0];
    const outbound = provider.apiFormat;
    if (!inbound || !translationSupported(inbound, outbound)) {
      throwIpcError(
        'UNSUPPORTED_CAPABILITY',
        'translation between this provider and agent format is not supported',
      );
    }
    const { baseUrl, token } = getProxy().registerRoute({
      agentId,
      providerId: provider.id,
      inboundFormat: inbound,
      outboundFormat: outbound,
      upstreamBaseUrl: provider.baseUrl,
      modelId: wireModelId,
    });
    // Write the loopback URL + the per-binding token. The REAL key is never written to
    // disk; the proxy resolves it main-side (resolveUpstreamKey) at request time.
    adapter.writeLive({ provider: { ...provider, baseUrl }, modelId: wireModelId, apiKey: token });
  }

  return {
    getSnapshot: snapshot,

    addProvider(input) {
      const provider: Provider = {
        id: randomUUID(),
        name: input.name,
        apiFormat: input.apiFormat,
        baseUrl: input.baseUrl,
        models: input.models,
        notes: input.notes,
        createdAt: Date.now(),
      };
      store.addProvider(provider);
      if (input.apiKey) secrets.set(providerSecretKey(provider.id), input.apiKey);
      return announce();
    },

    updateProvider(input) {
      const existing = store.getProvider(input.id);
      if (!existing) throwIpcError('NOT_FOUND', 'provider not found');

      const next: Provider = {
        ...existing,
        name: input.name ?? existing.name,
        apiFormat: input.apiFormat ?? existing.apiFormat,
        baseUrl: input.baseUrl ?? existing.baseUrl,
        models: input.models ?? existing.models,
        notes: input.notes !== undefined ? input.notes : existing.notes,
      };
      store.replaceProvider(next);

      // apiKey: string replaces, null clears, undefined leaves alone.
      if (input.apiKey === null) {
        secrets.delete(providerSecretKey(input.id));
      } else if (typeof input.apiKey === 'string' && input.apiKey !== '') {
        secrets.set(providerSecretKey(input.id), input.apiKey);
      }
      return announce();
    },

    removeProvider(id) {
      if (!store.getProvider(id)) throwIpcError('NOT_FOUND', 'provider not found');
      // Drop any cross-format proxy route that referenced this provider (a bound agent
      // would otherwise keep a live route whose upstream key just disappeared).
      for (const def of AGENTS) {
        if (store.getBinding(def.id)?.providerId === id) {
          getProxy().unregisterRoute({ agentId: def.id });
        }
      }
      store.removeProvider(id);
      secrets.delete(providerSecretKey(id));
      return announce();
    },

    setBinding(agentId, providerId, modelId) {
      const def = getAgentDef(agentId);
      if (!def) throwIpcError('INVALID_PARAMS', 'unknown agent');

      const provider = store.getProvider(providerId);
      if (!provider) throwIpcError('NOT_FOUND', 'provider not found');
      const model = provider.models.find((m) => m.id === modelId);
      if (!model) {
        throwIpcError('NOT_FOUND', 'model not found on this provider');
      }

      // Same-format writes the real key; cross-format registers a translation route and
      // writes a loopback URL + token instead (see applyBinding). Runs before the store
      // write so a config/route failure leaves the recorded binding consistent with disk.
      applyBinding(agentId, provider, model);

      store.setBinding(agentId, { providerId, modelId });
      return announce();
    },

    clearBinding(agentId) {
      // Drop any cross-format route so its token dies immediately (no-op if none).
      getProxy().unregisterRoute({ agentId });
      store.clearBinding(agentId);
      return announce();
    },

    restoreAgentDefault(agentId) {
      const def = getAgentDef(agentId);
      if (!def) throwIpcError('INVALID_PARAMS', 'unknown agent');
      const adapter = adapters.get(agentId);
      if (!adapter) throwIpcError('UNSUPPORTED_CAPABILITY', 'no adapter for this agent yet');

      // Restore the native config first (the risky, on-disk step); only then drop
      // the binding + route so a write failure leaves recorded state consistent with disk.
      adapter.restoreDefault();
      getProxy().unregisterRoute({ agentId });
      store.clearBinding(agentId);
      return announce();
    },

    fetchModels(input) {
      // Resolve the key main-side: a freshly-typed key wins; otherwise fall back
      // to the stored key of the named provider (edit mode with a blank field).
      const apiKey =
        input.apiKey && input.apiKey !== ''
          ? input.apiKey
          : input.providerId
            ? secrets.get(providerSecretKey(input.providerId))
            : null;
      return fetchProviderModels(
        {
          apiFormat: input.apiFormat,
          baseUrl: input.baseUrl,
          apiKey,
        },
        fetchImpl,
      );
    },

    revealKey(providerId) {
      if (!store.getProvider(providerId)) throwIpcError('NOT_FOUND', 'provider not found');
      // Deliberate plaintext read for the "view saved key" feature. Never log this
      // value; the caller (renderer) must hold it transiently only.
      return secrets.get(providerSecretKey(providerId));
    },

    resolveUpstreamKey(providerId) {
      // Main-side-only plaintext read for the proxy's outbound request. Never logged,
      // never returned across IPC (unlike revealKey, whose value reaches the renderer).
      return secrets.get(providerSecretKey(providerId));
    },

    rebuildProxyRoutes() {
      for (const def of AGENTS) {
        const binding = store.getBinding(def.id);
        if (!binding) continue;
        const provider = store.getProvider(binding.providerId);
        if (!provider) continue;
        // Same-format bindings talk to the provider directly — no route to rebuild.
        if (isFormatCompatible(def, provider)) continue;
        const model = provider.models.find((m) => m.id === binding.modelId);
        if (!model) continue;
        try {
          applyBinding(def.id, provider, model);
        } catch (err) {
          // A binding that is no longer translatable (e.g. the provider was edited to
          // gemini) is skipped, not fatal — startup must not crash on stale state.
          logger.warn('proxy.rebuild_skip', {
            agent: def.id,
            code: err instanceof Error ? err.message.match(/^\[([A-Z_]+)\]/)?.[1] : undefined,
          });
        }
      }
    },
  };
}
