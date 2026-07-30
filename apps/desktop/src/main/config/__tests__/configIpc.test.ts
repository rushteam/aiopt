import { describe, expect, it } from 'vitest';
import {
  createInMemoryRegistry,
  type IpcInvokeMeta,
  type InMemoryIpcRegistry,
} from '../../ipc/registry';
import { throwIpcError } from '../../ipc/validate';
import { registerConfigIpc, type BroadcastFn } from '../configIpc';
import { createConfigStore, type PreferencePersistence } from '../configStore';
import { IPC_CHANNELS, IPC_EVENTS, type PreferencesShape } from '../../../shared/ipc-channels';
import { decodeIpcError, isIpcError, type IpcErrorCode } from '../../../shared/ipc-errors';

const trusted: IpcInvokeMeta = { assertTrustedSender: () => {} };
const untrusted: IpcInvokeMeta = {
  assertTrustedSender: () => throwIpcError('PERMISSION_DENIED', 'nope'),
};

function memoryPersistence(seed: Record<string, unknown> = {}): PreferencePersistence {
  let store = { ...seed };
  return { load: () => ({ ...store }), save: (o) => { store = { ...o }; } };
}

/** Register config IPC over a fresh in-memory registry; capture broadcasts. */
function harness(seed: Record<string, unknown> = {}): {
  reg: InMemoryIpcRegistry;
  broadcasts: Array<{ channel: string; payload: unknown }>;
} {
  const reg = createInMemoryRegistry();
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const broadcast: BroadcastFn = (channel, payload) => broadcasts.push({ channel, payload });
  registerConfigIpc(reg, createConfigStore(memoryPersistence(seed)), broadcast);
  return { reg, broadcasts };
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

describe('config IPC', () => {
  it('get-all returns the effective snapshot for a trusted sender', async () => {
    const { reg } = harness({ theme: 'dark' });
    const result = (await reg.invoke(IPC_CHANNELS.configGetAll, undefined, trusted)) as PreferencesShape;
    expect(result).toEqual({ theme: 'dark' });
  });

  it('set persists the override and broadcasts the new snapshot', async () => {
    const { reg, broadcasts } = harness();
    const result = (await reg.invoke(
      IPC_CHANNELS.configSet,
      { key: 'theme', value: 'light' },
      trusted,
    )) as PreferencesShape;
    expect(result).toEqual({ theme: 'light' });
    expect(broadcasts).toEqual([{ channel: IPC_EVENTS.configChanged, payload: { theme: 'light' } }]);
  });

  it('reset restores the default and broadcasts', async () => {
    const { reg, broadcasts } = harness({ theme: 'light' });
    const result = (await reg.invoke(IPC_CHANNELS.configReset, { key: 'theme' }, trusted)) as PreferencesShape;
    expect(result).toEqual({ theme: 'system' });
    expect(broadcasts.at(-1)).toEqual({ channel: IPC_EVENTS.configChanged, payload: { theme: 'system' } });
  });

  it('rejects an untrusted sender with PERMISSION_DENIED and does not broadcast', async () => {
    const { reg, broadcasts } = harness();
    expect(await codeOf(() => reg.invoke(IPC_CHANNELS.configSet, { key: 'theme', value: 'dark' }, untrusted))).toBe(
      'PERMISSION_DENIED',
    );
    expect(broadcasts).toEqual([]);
  });

  it('rejects an unknown key with INVALID_PARAMS', async () => {
    const { reg } = harness();
    expect(await codeOf(() => reg.invoke(IPC_CHANNELS.configSet, { key: 'bogus', value: 'x' }, trusted))).toBe(
      'INVALID_PARAMS',
    );
  });

  it('rejects an invalid value with INVALID_PARAMS', async () => {
    const { reg } = harness();
    expect(await codeOf(() => reg.invoke(IPC_CHANNELS.configSet, { key: 'theme', value: 'neon' }, trusted))).toBe(
      'INVALID_PARAMS',
    );
  });

  it('rejects a non-object payload with INVALID_PARAMS', async () => {
    const { reg } = harness();
    expect(await codeOf(() => reg.invoke(IPC_CHANNELS.configSet, 'nope', trusted))).toBe('INVALID_PARAMS');
  });
});
