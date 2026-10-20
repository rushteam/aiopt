// Renderer-side routing status store — the live state of routing groups (member cooldown,
// counts, recent decisions) for the Providers page.
//
// Mirrors usageStore: fetched via `providers.routingStatus()` on first use, then kept in
// step by the throttled `providers:routing-status-changed` push. In-memory in main only;
// it carries ids, status codes and times — never content, keys or conversation keys.

import { EMPTY_ROUTING_STATUS, type RoutingStatusSnapshot } from '../../shared/routingStatus';

type Listener = () => void;

let snapshot: RoutingStatusSnapshot = EMPTY_ROUTING_STATUS;
let version = 0;
let initialized = false;
const listeners = new Set<Listener>();

function applySnapshot(next: RoutingStatusSnapshot | undefined): void {
  if (!next) return;
  snapshot = next;
  version += 1;
  listeners.forEach((listener) => listener());
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  window.aiopt.providers.onRoutingStatusChanged(applySnapshot);
  void window.aiopt.providers.routingStatus().then(applySnapshot);
}

export function subscribeRoutingStatusStore(listener: Listener): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRoutingStatusStoreVersion(): number {
  ensureInitialized();
  return version;
}

export function getRoutingStatusSnapshot(): RoutingStatusSnapshot {
  ensureInitialized();
  return snapshot;
}

/** End one member's cooldown now (in-memory only in main). */
export async function retryRoutingMemberNow(groupId: string, providerId: string, modelId: string): Promise<void> {
  ensureInitialized();
  applySnapshot(await window.aiopt.providers.routingRetryNow({ groupId, providerId, modelId }));
}
