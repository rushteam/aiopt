// Renderer-side usage store — the single copy of the aggregated usage snapshot the
// whole renderer reads.
//
// Mirrors providerStore's shape: the snapshot is fetched asynchronously via
// `usage.get()` on first use, then kept in step by the throttled `usage:changed`
// push from main. The only write is `clearUsage()`, which returns the emptied
// snapshot; the broadcast echo re-applies it (idempotent) for other windows.

import type { UsageSnapshot } from '../../shared/usageStats';

type Listener = () => void;

const EMPTY: UsageSnapshot = {
  totals: {
    requests: 0,
    okRequests: 0,
    errorRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  },
  byProvider: [],
  byAgent: [],
  byModel: [],
  daily: [],
  since: 0,
  until: 0,
  retentionDays: 0,
  eventCount: 0,
};

let snapshot: UsageSnapshot = EMPTY;
let version = 0;
let initialized = false;
const listeners = new Set<Listener>();

function applySnapshot(next: UsageSnapshot): void {
  snapshot = next;
  version += 1;
  listeners.forEach((listener) => listener());
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  // Track usage changes pushed from main (throttled snapshots).
  window.aiopt.usage.onChanged(applySnapshot);
  void window.aiopt.usage.get().then(applySnapshot);
}

/** Subscribe to store changes; returns an unsubscribe fn. */
export function subscribeUsageStore(listener: Listener): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Monotonic version for `useSyncExternalStore` getSnapshot — bumps on every change. */
export function getUsageStoreVersion(): number {
  ensureInitialized();
  return version;
}

export function getUsageSnapshot(): UsageSnapshot {
  ensureInitialized();
  return snapshot;
}

/** Clear all recorded usage. Applies the emptied snapshot returned by main. */
export async function clearUsage(): Promise<void> {
  ensureInitialized();
  applySnapshot(await window.aiopt.usage.clear());
}
