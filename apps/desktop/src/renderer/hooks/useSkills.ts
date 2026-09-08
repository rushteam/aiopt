// Subscribe the calling component to the renderer skills store.
//
// Mirrors `useUsage`: `useSyncExternalStore` tracks a monotonic version, and the
// actual snapshot is read from the store getter, so a component re-renders exactly
// when the sync matrix changes (a pull/push/import/delete here, or a rescan pushed
// from another window).

import { useSyncExternalStore } from 'react';
import {
  getSkillsSnapshot,
  getSkillsStoreVersion,
  subscribeSkillsStore,
} from '../lib/skillsStore';
import type { SkillsSnapshot } from '../../shared/skills';

export function useSkills(): SkillsSnapshot {
  useSyncExternalStore(subscribeSkillsStore, getSkillsStoreVersion, getSkillsStoreVersion);
  return getSkillsSnapshot();
}
