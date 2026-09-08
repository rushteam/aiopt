// Subscribe the calling component to the renderer provider store.
//
// Mirrors `useAppShortcut`'s pattern: `useSyncExternalStore` tracks a monotonic
// version, and the actual snapshot is read from the store getter, so a component
// re-renders exactly when the pool or a binding changes.

import { useSyncExternalStore } from 'react';
import {
  getProviderStoreVersion,
  getProvidersSnapshot,
  subscribeProviderStore,
} from '../lib/providerStore';
import type { ProvidersSnapshot } from '../../shared/ipc-channels';

export function useProviders(): ProvidersSnapshot {
  useSyncExternalStore(subscribeProviderStore, getProviderStoreVersion, getProviderStoreVersion);
  return getProvidersSnapshot();
}
