// Subscribe the calling component to the live routing status (see lib/routingStatusStore).

import { useSyncExternalStore } from 'react';
import {
  getRoutingStatusSnapshot,
  getRoutingStatusStoreVersion,
  subscribeRoutingStatusStore,
} from '../lib/routingStatusStore';
import type { RoutingStatusSnapshot } from '../../shared/routingStatus';

export function useRoutingStatus(): RoutingStatusSnapshot {
  useSyncExternalStore(subscribeRoutingStatusStore, getRoutingStatusStoreVersion, getRoutingStatusStoreVersion);
  return getRoutingStatusSnapshot();
}
