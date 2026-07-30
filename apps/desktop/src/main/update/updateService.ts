// Update service — owns the update status and drives checks through a provider.
//
// It models the check→notify flow only. Actually INSTALLING an update
// (downloading, verifying signatures, install-on-quit) is intentionally NOT here:
// that is the high-risk part of the updater and is gated by
// docs/dev-rules/updater.md. With the local stub the status is always
// `up-to-date`, so there is never anything to install.

import type { UpdateStatus } from '../../shared/ipc-channels';
import type { UpdateProvider } from './updateProvider';
import { toStatus } from './updateProvider';

export interface UpdateService {
  /** The last known status (starts `idle` until the first check). */
  getStatus(): UpdateStatus;
  /** Run a check; transitions idle/checking → result and notifies listeners. */
  check(): Promise<UpdateStatus>;
}

/** Notified on every status transition (wired to a renderer broadcast). */
export type UpdateStatusListener = (status: UpdateStatus) => void;

export function createUpdateService(
  provider: UpdateProvider,
  getCurrentVersion: () => string,
  onStatusChange: UpdateStatusListener,
): UpdateService {
  let status: UpdateStatus = { state: 'idle', currentVersion: getCurrentVersion() };

  function set(next: UpdateStatus): UpdateStatus {
    status = next;
    onStatusChange(status);
    return status;
  }

  return {
    getStatus: () => status,

    async check() {
      const currentVersion = getCurrentVersion();
      set({ state: 'checking', currentVersion });
      try {
        const result = await provider.checkForUpdates(currentVersion);
        return set(toStatus(currentVersion, result));
      } catch {
        // A failed check is a status, not a crash — surface it as `error`.
        return set({ state: 'error', currentVersion });
      }
    },
  };
}
