import { describe, expect, it } from 'vitest';
import { createUpdateService } from '../updateService';
import { createLocalStubUpdateProvider } from '../localStubUpdateProvider';
import type { UpdateProvider } from '../updateProvider';
import type { UpdateStatus } from '../../../shared/ipc-channels';

function harness(provider: UpdateProvider, version = '1.2.3') {
  const events: UpdateStatus[] = [];
  const service = createUpdateService(provider, () => version, (s) => events.push(s));
  return { service, events };
}

describe('update service', () => {
  it('starts idle at the current version', () => {
    const { service } = harness(createLocalStubUpdateProvider());
    expect(service.getStatus()).toEqual({ state: 'idle', currentVersion: '1.2.3' });
  });

  it('the stub check reports up-to-date and broadcasts checking → up-to-date', async () => {
    const { service, events } = harness(createLocalStubUpdateProvider());
    const result = await service.check();
    expect(result).toEqual({ state: 'up-to-date', currentVersion: '1.2.3' });
    expect(service.getStatus()).toEqual(result);
    // A `checking` status is announced before the resolved one.
    expect(events.map((e) => e.state)).toEqual(['checking', 'up-to-date']);
  });

  it('folds an available update into the status with its next version', async () => {
    const provider: UpdateProvider = {
      checkForUpdates: async () => ({ state: 'update-available', nextVersion: '2.0.0' }),
    };
    const { service } = harness(provider);
    expect(await service.check()).toEqual({
      state: 'update-available',
      currentVersion: '1.2.3',
      nextVersion: '2.0.0',
    });
  });

  it('surfaces a provider failure as an error status, not a crash', async () => {
    const provider: UpdateProvider = {
      checkForUpdates: async () => {
        throw new Error('network down');
      },
    };
    const { service, events } = harness(provider);
    expect(await service.check()).toEqual({ state: 'error', currentVersion: '1.2.3' });
    expect(events.at(-1)?.state).toBe('error');
  });
});
