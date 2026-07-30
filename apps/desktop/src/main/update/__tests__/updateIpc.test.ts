import { describe, expect, it } from 'vitest';
import {
  createInMemoryRegistry,
  type IpcInvokeMeta,
  type InMemoryIpcRegistry,
} from '../../ipc/registry';
import { throwIpcError } from '../../ipc/validate';
import { registerUpdateIpc } from '../updateIpc';
import { createUpdateService } from '../updateService';
import { createLocalStubUpdateProvider } from '../localStubUpdateProvider';
import { IPC_CHANNELS, type UpdateStatus } from '../../../shared/ipc-channels';
import { decodeIpcError, isIpcError, type IpcErrorCode } from '../../../shared/ipc-errors';

const trusted: IpcInvokeMeta = { assertTrustedSender: () => {} };
const untrusted: IpcInvokeMeta = {
  assertTrustedSender: () => throwIpcError('PERMISSION_DENIED', 'nope'),
};

function harness(): InMemoryIpcRegistry {
  const reg = createInMemoryRegistry();
  const service = createUpdateService(createLocalStubUpdateProvider(), () => '9.9.9', () => {});
  registerUpdateIpc(reg, service);
  return reg;
}

async function codeOf(fn: () => Promise<unknown>): Promise<IpcErrorCode> {
  try {
    await fn();
  } catch (err) {
    if (isIpcError(err)) return err.code;
    if (err instanceof Error) return decodeIpcError(err.message).code;
  }
  throw new Error('expected the invocation to throw');
}

describe('update IPC', () => {
  it('get-status returns the current status for a trusted sender', async () => {
    const reg = harness();
    const status = (await reg.invoke(IPC_CHANNELS.updateGetStatus, undefined, trusted)) as UpdateStatus;
    expect(status).toEqual({ state: 'idle', currentVersion: '9.9.9' });
  });

  it('check runs the stub and returns up-to-date', async () => {
    const reg = harness();
    const status = (await reg.invoke(IPC_CHANNELS.updateCheck, undefined, trusted)) as UpdateStatus;
    expect(status).toEqual({ state: 'up-to-date', currentVersion: '9.9.9' });
  });

  it('rejects an untrusted check with PERMISSION_DENIED', async () => {
    const reg = harness();
    expect(await codeOf(() => reg.invoke(IPC_CHANNELS.updateCheck, undefined, untrusted))).toBe(
      'PERMISSION_DENIED',
    );
  });
});
