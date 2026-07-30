import { describe, expect, it } from 'vitest';
import { createInMemoryRegistry, type IpcInvokeMeta } from '../../ipc/registry';
import { throwIpcError } from '../../ipc/validate';
import { registerAppInfoIpc } from '../appInfoIpc';
import { IPC_CHANNELS, type AppVersionsResult } from '../../../shared/ipc-channels';
import { decodeIpcError, isIpcError } from '../../../shared/ipc-errors';

const trusted: IpcInvokeMeta = { assertTrustedSender: () => {} };
const untrusted: IpcInvokeMeta = {
  assertTrustedSender: () => throwIpcError('PERMISSION_DENIED', 'nope'),
};

const versions: AppVersionsResult = { app: '1.2.3', electron: '30', chrome: '124', node: '20' };

describe('app-info IPC', () => {
  it('returns the injected versions for a trusted sender', async () => {
    const reg = createInMemoryRegistry();
    registerAppInfoIpc(reg, () => versions);
    expect(await reg.invoke(IPC_CHANNELS.appGetVersions, undefined, trusted)).toEqual(versions);
  });

  it('rejects an untrusted sender with PERMISSION_DENIED', async () => {
    const reg = createInMemoryRegistry();
    registerAppInfoIpc(reg, () => versions);
    try {
      await reg.invoke(IPC_CHANNELS.appGetVersions, undefined, untrusted);
    } catch (err) {
      const code = isIpcError(err)
        ? err.code
        : err instanceof Error
          ? decodeIpcError(err.message).code
          : 'INTERNAL';
      expect(code).toBe('PERMISSION_DENIED');
      return;
    }
    throw new Error('expected the invocation to throw');
  });
});
