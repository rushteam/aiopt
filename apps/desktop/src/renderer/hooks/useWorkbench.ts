// Subscribe the calling component to the renderer workbench store.
//
// Mirrors `useUsage`: `useSyncExternalStore` tracks a monotonic version, and the snapshot is
// read from the store getter, so a component re-renders exactly when the workbench changes.

import { useSyncExternalStore } from 'react';
import {
  getWorkbenchSnapshot,
  getWorkbenchStoreVersion,
  subscribeWorkbenchStore,
} from '../lib/workbenchStore';
import type { WorkbenchSnapshot } from '../../shared/workbench';

export function useWorkbench(): WorkbenchSnapshot {
  useSyncExternalStore(subscribeWorkbenchStore, getWorkbenchStoreVersion, getWorkbenchStoreVersion);
  return getWorkbenchSnapshot();
}
