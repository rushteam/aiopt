// Subscribe the calling component to the renderer usage store.
//
// Mirrors `useProviders`: `useSyncExternalStore` tracks a monotonic version, and
// the actual snapshot is read from the store getter, so a component re-renders
// exactly when usage changes (a live proxy attempt, or a clear).

import { useSyncExternalStore } from 'react';
import {
  getUsageSnapshot,
  getUsageStoreVersion,
  subscribeUsageStore,
} from '../lib/usageStore';
import type { UsageSnapshot } from '../../shared/usageStats';

export function useUsage(): UsageSnapshot {
  useSyncExternalStore(subscribeUsageStore, getUsageStoreVersion, getUsageStoreVersion);
  return getUsageSnapshot();
}
