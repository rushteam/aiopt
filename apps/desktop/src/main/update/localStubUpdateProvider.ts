// Local stub update provider — the batteries-included default.
//
// It always reports "up-to-date": the framework deliberately ships with NO real
// update feed. Replace this provider with one that queries your release channel;
// doing so is a high-risk change gated by docs/dev-rules/updater.md.

import type { UpdateProvider, UpdateCheckResult } from './updateProvider';

export function createLocalStubUpdateProvider(): UpdateProvider {
  return {
    async checkForUpdates(): Promise<UpdateCheckResult> {
      return { state: 'up-to-date' };
    },
  };
}
