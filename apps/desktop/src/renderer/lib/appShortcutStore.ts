// Renderer-side app-shortcut store — the single copy of the effective bindings
// the whole renderer reads.
//
// It mirrors main's override state: seeded synchronously from the preload bridge
// on first use (so the store is correct on first render), then kept in step by the
// `app-shortcuts:changed` push. The effective combo table is derived by the SAME
// shared/appShortcuts code the main process runs, so the settings list, the
// `useAppShortcut` hook, and the native menu can never disagree.
//
// Writes go through main (which re-validates); the returned override set is applied
// immediately, and the broadcast echo re-applies it (idempotent) for other windows.

import {
  getEffectiveAppShortcuts,
  type AppShortcutCombo,
  type AppShortcutId,
  type AppShortcutOverrides,
} from '../../shared/appShortcuts';

type Listener = () => void;

let overrides: AppShortcutOverrides = {};
let platform = 'darwin';
let effective = new Map<AppShortcutId, AppShortcutCombo[]>();
let version = 0;
let initialized = false;
const listeners = new Set<Listener>();

function applyOverrides(next: AppShortcutOverrides): void {
  overrides = next;
  effective = getEffectiveAppShortcuts(overrides, platform);
  version += 1;
  listeners.forEach((listener) => listener());
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  const state = window.hearth.appShortcuts.getState();
  platform = state.platform;
  overrides = state.overrides;
  effective = getEffectiveAppShortcuts(overrides, platform);
  // Track rebinds from any window (including our own writes' echo).
  window.hearth.appShortcuts.onChanged((event) => applyOverrides(event.overrides));
}

/** Subscribe to store changes; returns an unsubscribe fn. */
export function subscribeAppShortcutStore(listener: Listener): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Monotonic version for `useSyncExternalStore` getSnapshot — changes iff the
 * effective table changed. Callers read the actual data via the getters below.
 */
export function getAppShortcutStoreVersion(): number {
  ensureInitialized();
  return version;
}

export function getAppShortcutPlatform(): string {
  ensureInitialized();
  return platform;
}

export function getAppShortcutOverrides(): AppShortcutOverrides {
  ensureInitialized();
  return overrides;
}

/** Effective combos for one id (defaults merged with overrides). Empty = disabled/unbound. */
export function getEffectiveCombosFor(id: AppShortcutId): AppShortcutCombo[] {
  ensureInitialized();
  return effective.get(id) ?? [];
}

export async function setAppShortcutOverride(
  id: AppShortcutId,
  combo: AppShortcutCombo | null,
): Promise<void> {
  ensureInitialized();
  const result = await window.hearth.appShortcuts.setOverride(id, combo);
  applyOverrides(result.overrides);
}

export async function clearAppShortcutOverride(id: AppShortcutId): Promise<void> {
  ensureInitialized();
  const result = await window.hearth.appShortcuts.clearOverride(id);
  applyOverrides(result.overrides);
}

export async function resetAllAppShortcuts(): Promise<void> {
  ensureInitialized();
  const result = await window.hearth.appShortcuts.resetAll();
  applyOverrides(result.overrides);
}
