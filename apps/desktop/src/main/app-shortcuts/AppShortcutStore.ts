// Main-side store for user overrides of app shortcuts.
//
// Faithful port of Cindy's AppShortcutStore. Electron-free (paths + platform are
// injected) so it unit-tests without Electron. The persistence red line
// (docs/dev-rules/configuration-and-overrides.md): the file holds ONLY the ids
// the user explicitly changed — defaults are never written. Effective value =
// registry defaults (which evolve with the code) merged with overrides; "reset"
// = delete the override key. On load, `normalizeAppShortcutOverrides` drops
// unknown ids / invalid combos, so a file written by an older version self-heals.

import fs from 'node:fs';
import path from 'node:path';
import { renameSyncWithRetry } from '../fsRetry';
import { readUtf8WithoutBom } from '../storeFile';

import {
  comboToElectronAccelerator,
  findAppShortcutConflict,
  getAppShortcutDefinition,
  getEffectiveAppShortcuts,
  isAppShortcutAvailableOnPlatform,
  isAppShortcutComboBindable,
  isAppShortcutId,
  normalizeAppShortcutCombo,
  normalizeAppShortcutOverrides,
  type AppShortcutCombo,
  type AppShortcutId,
  type AppShortcutOverrides,
} from '../../shared/appShortcuts';
import { isSystemReservedShortcut } from '../../shared/keyboardReserved';
import { logger } from '../logger';

const log = logger.child('app-shortcuts');

export const APP_SHORTCUTS_FILE_NAME = 'app-shortcuts.v1.json';

/**
 * setOverride's failure reason. The store returns a plain business value; the IPC
 * layer maps it to a coded error, so unit tests need no Electron.
 */
export type AppShortcutOverrideRejection =
  | 'unknown-id'
  | 'not-rebindable'
  | 'platform-unavailable'
  | 'invalid-combo'
  | 'not-bindable'
  | 'system-reserved'
  | 'menu-inexpressible'
  | 'conflict';

export interface AppShortcutStoreOptions {
  /** Absolute path the overrides persist to (prod: userData/app-shortcuts.v1.json). */
  getFilePath: () => string;
  /** Injected process.platform, so tests can assert per-platform behaviour. */
  platform: string;
  /** Called when overrides change (broadcast to renderers + rebuild the native menu). */
  onChanged?: (overrides: AppShortcutOverrides) => void;
}

export class AppShortcutStore {
  private overrides: AppShortcutOverrides | null = null;
  private readonly changeListeners = new Set<(overrides: AppShortcutOverrides) => void>();

  constructor(private readonly options: AppShortcutStoreOptions) {}

  /** Internal main-side subscription (e.g. menu rebuild); returns an unsubscribe fn. */
  subscribe(listener: (overrides: AppShortcutOverrides) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  getOverrides(): AppShortcutOverrides {
    return { ...this.load() };
  }

  /** Live effective combos for one id — used by the menu accelerator builder. */
  getEffectiveCombos(id: AppShortcutId): AppShortcutCombo[] {
    if (!isAppShortcutAvailableOnPlatform(id, this.options.platform)) return [];
    const override = this.load()[id];
    if (override === null) return []; // user deleted the binding
    if (override) return [override];
    return getAppShortcutDefinition(id).getDefaultCombos(this.options.platform);
  }

  getEffectiveMap(): Map<AppShortcutId, AppShortcutCombo[]> {
    return getEffectiveAppShortcuts(this.load(), this.options.platform);
  }

  /**
   * Validate and write one override; returns the rejection reason on failure,
   * null on success. `combo === null` deletes the binding (disables the
   * shortcut) and skips combo validation.
   */
  setOverride(id: unknown, combo: unknown): AppShortcutOverrideRejection | null {
    if (!isAppShortcutId(id)) return 'unknown-id';
    const def = getAppShortcutDefinition(id);
    if (!def.rebindable) return 'not-rebindable';
    if (!isAppShortcutAvailableOnPlatform(id, this.options.platform)) return 'platform-unavailable';
    if (combo === null) {
      const current = this.load();
      this.replaceOverrides({ ...current, [id]: null });
      return null;
    }
    const normalized = normalizeAppShortcutCombo(combo);
    if (!normalized) return 'invalid-combo';
    if (!isAppShortcutComboBindable(normalized)) return 'not-bindable';
    if (isSystemReservedShortcut(normalized, platformFamily(this.options.platform))) {
      return 'system-reserved';
    }
    // On darwin a menu-only id's combo must be expressible as an Electron
    // accelerator, otherwise the menu shows no accelerator and there is no
    // keypress fallback — the binding would be a no-op.
    if (
      def.menuBacked &&
      this.options.platform === 'darwin' &&
      comboToElectronAccelerator(normalized, 'darwin') === null
    ) {
      return 'menu-inexpressible';
    }
    const current = this.load();
    // Cross-id conflict fallback (the renderer pre-checks; this guards concurrent
    // windows / direct IPC): reject if it collides within an overlapping scope.
    if (findAppShortcutConflict(id, normalized, current, this.options.platform)) {
      return 'conflict';
    }
    this.replaceOverrides({ ...current, [id]: normalized });
    return null;
  }

  /** Reset one item = delete its override. Unknown id is a silent no-op (idempotent). */
  clearOverride(id: unknown): void {
    if (!isAppShortcutId(id)) return;
    const current = this.load();
    if (!(id in current)) return;
    const next = { ...current };
    delete next[id];
    this.replaceOverrides(next);
  }

  /** Reset all = clear every override. */
  resetAll(): void {
    const current = this.load();
    if (Object.keys(current).length === 0) return;
    this.replaceOverrides({});
  }

  private load(): AppShortcutOverrides {
    if (this.overrides) return this.overrides;
    const filePath = this.options.getFilePath();
    try {
      const raw = readUtf8WithoutBom(filePath);
      const parsed = JSON.parse(raw) as unknown;
      const overridesRaw =
        parsed && typeof parsed === 'object'
          ? (parsed as { overrides?: unknown }).overrides
          : undefined;
      this.overrides = normalizeAppShortcutOverrides(overridesRaw, this.options.platform);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('overrides_read_failed', {
          reason: error instanceof Error ? error.name : typeof error,
        });
      }
      this.overrides = {};
    }
    return this.overrides;
  }

  private replaceOverrides(next: AppShortcutOverrides): void {
    // Commit the candidate only after the atomic file replacement succeeds.
    this.save(next);
    this.overrides = next;
    const snapshot = { ...next };
    this.options.onChanged?.(snapshot);
    this.changeListeners.forEach((listener) => listener(snapshot));
  }

  private save(overrides: AppShortcutOverrides): void {
    const filePath = this.options.getFilePath();
    const tmp = `${filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, overrides }, null, 2), 'utf-8');
      renameSyncWithRetry(tmp, filePath);
    } catch (error) {
      log.warn('overrides_write_failed', {
        reason: error instanceof Error ? error.name : typeof error,
      });
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Best-effort cleanup; preserve the original write error.
      }
      throw error;
    }
  }
}

function platformFamily(platform: string): 'mac' | 'windows' | 'other' {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'windows';
  return 'other';
}
