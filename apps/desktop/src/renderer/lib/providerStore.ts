// Renderer-side provider store — the single copy of the pool + agent bindings the
// whole renderer reads.
//
// Unlike the app-shortcut store (seeded synchronously), the snapshot is fetched
// asynchronously via `providers.list()` on first use, then kept in step by the
// `providers:changed` push. Writes go through main (which re-validates and applies
// the binding to the agent's config); the returned snapshot is applied immediately,
// and the broadcast echo re-applies it (idempotent) for other windows.

import type {
  ProviderAddRequest,
  ProviderFetchModelsRequest,
  ProviderUpdateRequest,
  ProvidersSnapshot,
} from '../../shared/ipc-channels';
import type { AgentId, ProviderModel } from '../../shared/aiProviders';

type Listener = () => void;

const EMPTY: ProvidersSnapshot = { providers: [], agents: [], proxyPort: null };

let snapshot: ProvidersSnapshot = EMPTY;
let version = 0;
let initialized = false;
const listeners = new Set<Listener>();

function applySnapshot(next: ProvidersSnapshot): void {
  snapshot = next;
  version += 1;
  listeners.forEach((listener) => listener());
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  // Track pool/binding changes from any window (including our own writes' echo).
  window.aiopt.providers.onChanged(applySnapshot);
  void window.aiopt.providers.list().then(applySnapshot);
}

/** Subscribe to store changes; returns an unsubscribe fn. */
export function subscribeProviderStore(listener: Listener): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Monotonic version for `useSyncExternalStore` getSnapshot — bumps on every change. */
export function getProviderStoreVersion(): number {
  ensureInitialized();
  return version;
}

export function getProvidersSnapshot(): ProvidersSnapshot {
  ensureInitialized();
  return snapshot;
}

export async function addProvider(input: ProviderAddRequest): Promise<void> {
  ensureInitialized();
  applySnapshot(await window.aiopt.providers.add(input));
}

export async function updateProvider(input: ProviderUpdateRequest): Promise<void> {
  ensureInitialized();
  applySnapshot(await window.aiopt.providers.update(input));
}

export async function removeProvider(id: string): Promise<void> {
  ensureInitialized();
  applySnapshot(await window.aiopt.providers.remove(id));
}

export async function setAgentBinding(
  agentId: AgentId,
  providerId: string,
  modelId: string,
): Promise<void> {
  ensureInitialized();
  applySnapshot(await window.aiopt.providers.setBinding(agentId, providerId, modelId));
}

export async function clearAgentBinding(agentId: AgentId): Promise<void> {
  ensureInitialized();
  applySnapshot(await window.aiopt.providers.clearBinding(agentId));
}

/**
 * Undo AiOpt's takeover of an agent: restore its native config to the pre-AiOpt
 * state and clear the binding. Its stored API keys are untouched.
 */
export async function restoreAgentDefault(agentId: AgentId): Promise<void> {
  ensureInitialized();
  applySnapshot(await window.aiopt.providers.restoreDefault(agentId));
}

/**
 * Fetch a provider's models from its API. Read-only — it discovers models for the
 * add/edit form and does NOT mutate the pool, so it never applies a snapshot.
 */
export async function fetchProviderModels(
  input: ProviderFetchModelsRequest,
): Promise<ProviderModel[]> {
  ensureInitialized();
  const { models } = await window.aiopt.providers.fetchModels(input);
  return models;
}

/**
 * GATED: fetch a provider's stored key in PLAINTEXT for viewing. Read-only, does not
 * touch the pool. The caller must hold the returned value transiently only — never
 * persist or log it. Null when the provider has no key stored.
 */
export async function revealProviderKey(providerId: string): Promise<string | null> {
  ensureInitialized();
  const { key } = await window.aiopt.providers.revealKey(providerId);
  return key;
}

/**
 * Copy a proxied agent's loopback config to the clipboard. The token is written to the
 * clipboard main-side and never reaches the renderer — this returns only whether a live
 * route existed to copy. Read-only w.r.t. the pool.
 */
export async function copyProxyConfig(agentId: AgentId): Promise<boolean> {
  ensureInitialized();
  const { copied } = await window.aiopt.providers.copyProxyConfig(agentId);
  return copied;
}

/**
 * Move the loopback proxy to a fresh port and re-sync every proxied agent to it. The updated
 * snapshot (with the new port) arrives via the `providers:changed` push, so this doesn't apply
 * one itself — it just returns the new port for immediate feedback.
 */
export async function refreshProxyPort(): Promise<number> {
  ensureInitialized();
  const { port } = await window.aiopt.providers.refreshProxyPort();
  return port;
}
