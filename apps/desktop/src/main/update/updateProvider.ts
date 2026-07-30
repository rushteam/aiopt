// Update provider — the seam a real update backend implements.
//
// It answers ONE question: given the running version, is there a newer one? It
// does not download or install anything. Wiring a real feed (electron-updater, a
// release server, code-signing, install-on-quit) is a HIGH-RISK change gated by
// docs/dev-rules/updater.md — do not add it here without the gatekeeper's
// sign-off. The framework ships a local stub (localStubUpdateProvider.ts).

import type { UpdateStatus } from '../../shared/ipc-channels';

/** The subset of UpdateStatus a provider can return (never `idle`/`checking`). */
export type UpdateCheckResult =
  | { state: 'up-to-date' }
  | { state: 'update-available'; nextVersion: string }
  | { state: 'error' };

export interface UpdateProvider {
  /** Check whether a version newer than `currentVersion` exists. */
  checkForUpdates(currentVersion: string): Promise<UpdateCheckResult>;
}

/** Fold a provider result plus the current version into a full wire status. */
export function toStatus(currentVersion: string, result: UpdateCheckResult): UpdateStatus {
  if (result.state === 'update-available') {
    return { state: 'update-available', currentVersion, nextVersion: result.nextVersion };
  }
  return { state: result.state, currentVersion };
}
