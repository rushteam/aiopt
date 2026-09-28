// Local stub update provider — the batteries-included default.
//
// It always reports "up-to-date". Production uses githubReleaseUpdateProvider
// (check-only). This stub remains for tests. Downloading or installing an update
// is still gated by docs/dev-rules/updater.md.

import type { UpdateProvider, UpdateCheckResult } from './updateProvider';

export function createLocalStubUpdateProvider(): UpdateProvider {
  return {
    async checkForUpdates(): Promise<UpdateCheckResult> {
      return { state: 'up-to-date' };
    },
  };
}
