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
  type ApiFormat,
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
   * binding. The port + tokens are now persisted and reused, so this is normally an
   * idempotent replay that rewrites the SAME baseUrl+token an agent already cached (self-
   * healing). It still matters because it re-applies each binding when the proxy-mode
   * preference flips, and covers the rare case where the persisted port was taken and the
   * proxy fell back to a fresh one.
   */
  rebuildProxyRoutes(): void;
  /**
   * Copy a proxied agent's loopback endpoint (an OpenAI-compatible base URL + token) to the
   * clipboard so another tool can reuse the local proxy. Returns `{ copied: false }` when the
   * agent has no live proxy route. The token is written to the clipboard MAIN-SIDE and never
   * returned to the caller — it must not cross IPC back to the renderer.
   */
  copyProxyConfig(agentId: AgentId): { copied: boolean };
  /**
   * Move the loopback proxy to a fresh port and re-sync every proxied agent to the new
   * address. Rebinds the server (new OS-assigned port, guaranteed free), then replays each
   * binding — reusing the stable per-binding tokens but rewriting the on-disk baseUrl to the
   * new port — and broadcasts the fresh snapshot. The user's manual escape hatch for a port
   * collision. Returns `{ port }` (the port is not a secret; it already sits plaintext in
   * each agent's config). A copied config for an EXTERNAL tool must be re-copied afterwards.
   */
  refreshProxyPort(): Promise<{ port: number }>;
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
  // Read the effective "proxy mode" preference. When false (default), a same-format
  // binding is written to talk to the provider directly (so it keeps working when AiOpt
  // isn't running); when true, a same-format binding is ALSO routed through the proxy
  // (identity passthrough) so its usage is counted and its key stays off disk.
  // Cross-format always routes regardless. A thunk so the live value is read at each
  // (re)bind, not frozen at construction.
  getProxyMode: () => boolean = () => false,
  // Injected outbound transport for model discovery (Electron `net.fetch` in
  // production; a stub in tests). Defaults to the global fetch as a fallback.
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  // Write text to the OS clipboard (Electron `clipboard.writeText` in production; a stub
  // in tests). Injected so this module stays Electron-free. Used ONLY by copyProxyConfig,
  // which assembles a snippet containing the proxy token and writes it here — the token is
  // never returned to the caller. Defaults to a no-op so existing constructors need not
  // supply it (copyProxyConfig then silently does nothing).
  copyToClipboard: (text: string) => void = () => {},
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
    const proxyPort = getProxy().getPort();
    return {
      providers: store.listProviders().map(toSummary),
      // The live loopback port, or null before the proxy has bound (-1). Not a secret — it
      // already sits in each proxied agent's on-disk baseUrl; the renderer shows it and offers
      // the "refresh port" action. The token is never included.
      proxyPort: proxyPort >= 0 ? proxyPort : null,
      agents: AGENTS.map((def) => ({
        id: def.id,
        name: def.name,
        acceptedFormats: def.acceptedFormats,
        mode: def.mode,
        installed: adapters.get(def.id)?.detectInstalled() ?? false,
        binding: store.getBinding(def.id),
        // True only when a live loopback route exists (proxied binding), so the renderer
        // can offer "copy proxy config". Never exposes the token itself.
        proxied: getProxy().isRouted(def.id),
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

    const outbound = provider.apiFormat;
    const sameFormat = isFormatCompatible(def, provider);
    // A same-format binding speaks the provider's own format; a cross-format one speaks
    // the agent's first accepted format and is translated to the provider's.
    const inbound = sameFormat ? outbound : def.acceptedFormats[0];

    // Direct config (real key on disk, no proxy hop) when the formats already match AND
    // EITHER: proxy mode is off (the default — a same-format binding connects directly),
    // OR the pair can't be proxied at all (e.g. a gemini binding — gemini has no proxy
    // dialect, so a same-format gemini binding is always direct).
    const proxyable = inbound !== undefined && translationSupported(inbound, outbound);
    const direct = sameFormat && (!getProxyMode() || !proxyable);

    if (direct) {
      // Drop any stale route left by a previous proxied binding for this agent.
      getProxy().unregisterRoute({ agentId });
      const apiKey = secrets.get(providerSecretKey(provider.id));
      adapter.writeLive({ provider, modelId: wireModelId, apiKey });
      return;
    }

    // Routed through the proxy — either a cross-format translation (Anthropic ⇄ Chat
    // Completions; Responses → Chat Completions / Anthropic) or a same-format identity
    // passthrough (so usage is counted and the key stays off disk). Anything the proxy
    // can't carry is refused here.
    if (!inbound || !proxyable) {
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

  /**
   * Replay every binding through applyBinding. Shared by the public `rebuildProxyRoutes`
   * (startup / proxy-mode flip) and `refreshProxyPort` (rewrite each agent to a new port).
   * A binding that is no longer bindable is skipped, not fatal.
   */
  function rebuildRoutes(): void {
    for (const def of AGENTS) {
      const binding = store.getBinding(def.id);
      if (!binding) continue;
      const provider = store.getProvider(binding.providerId);
      if (!provider) continue;
      const model = provider.models.find((m) => m.id === binding.modelId);
      if (!model) continue;
      try {
        applyBinding(def.id, provider, model);
      } catch (err) {
        // A binding that is no longer bindable (e.g. the provider was edited to a
        // format this agent can't reach) is skipped, not fatal — a preference flip,
        // startup, or a port refresh must not crash on stale state.
        logger.warn('proxy.rebuild_skip', {
          agent: def.id,
          code: err instanceof Error ? err.message.match(/^\[([A-Z_]+)\]/)?.[1] : undefined,
        });
      }
    }
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
      // Replay EVERY binding, not just cross-format ones. Two reasons: (1) at startup the
      // proxy identity (port + tokens) is persisted and reused, so this normally rewrites the
      // SAME baseUrl/token already on disk (idempotent self-heal; only differs if the port was
      // taken and the proxy fell back); (2) when the proxy-mode preference flips, this
      // re-applies each binding so it moves between the direct config and the loopback route.
      // applyBinding itself decides direct vs routed.
      rebuildRoutes();
    },

    copyProxyConfig(agentId) {
      const def = getAgentDef(agentId);
      if (!def) throwIpcError('INVALID_PARAMS', 'unknown agent');
      const endpoint = getProxy().endpointFor(agentId);
      // No live route → nothing to copy (a direct binding, or none). Not an error: the
      // renderer only offers this for a proxied agent, but state can race a binding change.
      if (!endpoint) return { copied: false };
      // Assemble an OpenAI-compatible snippet. The loopback base URL already carries the
      // token in its path; the key slot repeats it because clients require a non-empty key
      // (it is NOT the real provider key — that stays main-side). Written to the clipboard
      // here so the token never crosses back over IPC to the renderer.
      const snippet = proxyConfigSnippet(endpoint);
      copyToClipboard(snippet);
      // Log the act, never the value — the snippet holds a secret-class token.
      logger.info('proxy.copy_config', { agent: agentId });
      return { copied: true };
    },

    async refreshProxyPort() {
      // Move the listener to a fresh port (routes/tokens preserved), then replay every binding
      // so each proxied agent's on-disk baseUrl is rewritten to the new port. rebuildProxyRoutes
      // reuses the stable token (sameSpec) and only swaps the port segment of the URL.
      const port = await getProxy().rebindPort();
      rebuildRoutes();
      logger.info('proxy.refresh_port', { port });
      // Push the new port (and any re-synced state) to every window.
      announce();
      return { port };
    },
  };
}

/**
 * Render a proxied endpoint as a copy-pasteable config block, using the env var names of the
 * dialect the loopback actually speaks (the route's INBOUND format), so the snippet is honest:
 * an anthropic-inbound route serves `/v1/messages`, not the OpenAI path. The token lives in
 * both the base URL path and the key slot (clients demand a non-empty key); it is a loopback
 * credential, not the real provider key. Pure helper for testability.
 */
export function proxyConfigSnippet(endpoint: {
  baseUrl: string;
  token: string;
  modelId: string;
  inboundFormat: ApiFormat;
}): string {
  // Gemini never routes through the proxy, so it can't reach here; the other three map to a
  // conventional (base-url, key) env pair each.
  const prefix = endpoint.inboundFormat === 'anthropic' ? 'ANTHROPIC' : 'OPENAI';
  return [
    `${prefix}_BASE_URL=${endpoint.baseUrl}`,
    `${prefix}_API_KEY=${endpoint.token}`,
    `MODEL=${endpoint.modelId}`,
  ].join('\n');
}
