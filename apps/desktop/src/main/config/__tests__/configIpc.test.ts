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

/** Register config IPC over a fresh in-memory registry; capture broadcasts + proxy-mode hook calls. */
function harness(seed: Record<string, unknown> = {}): {
  reg: InMemoryIpcRegistry;
  broadcasts: Array<{ channel: string; payload: unknown }>;
  proxyModeCalls: boolean[];
} {
  const reg = createInMemoryRegistry();
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const broadcast: BroadcastFn = (channel, payload) => broadcasts.push({ channel, payload });
  const proxyModeCalls: boolean[] = [];
  registerConfigIpc(reg, createConfigStore(memoryPersistence(seed)), broadcast, {
    onProxyModeChange: (v) => proxyModeCalls.push(v),
  });
  return { reg, broadcasts, proxyModeCalls };
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
    expect(result).toEqual({ theme: 'dark', language: 'system', skillsLibrary: 'app', proxyMode: false, warnOnQuitWithProxy: true });
  });

  it('set persists the override and broadcasts the new snapshot', async () => {
    const { reg, broadcasts } = harness();
    const result = (await reg.invoke(
      IPC_CHANNELS.configSet,
      { key: 'theme', value: 'light' },
      trusted,
    )) as PreferencesShape;
    expect(result).toEqual({ theme: 'light', language: 'system', skillsLibrary: 'app', proxyMode: false, warnOnQuitWithProxy: true });
    expect(broadcasts).toEqual([
      { channel: IPC_EVENTS.configChanged, payload: { theme: 'light', language: 'system', skillsLibrary: 'app', proxyMode: false, warnOnQuitWithProxy: true } },
    ]);
  });

  it('reset restores the default and broadcasts', async () => {
    const { reg, broadcasts } = harness({ theme: 'light' });
    const result = (await reg.invoke(IPC_CHANNELS.configReset, { key: 'theme' }, trusted)) as PreferencesShape;
    expect(result).toEqual({ theme: 'system', language: 'system', skillsLibrary: 'app', proxyMode: false, warnOnQuitWithProxy: true });
    expect(broadcasts.at(-1)).toEqual({
      channel: IPC_EVENTS.configChanged,
      payload: { theme: 'system', language: 'system', skillsLibrary: 'app', proxyMode: false, warnOnQuitWithProxy: true },
    });
  });

  it('setting proxyMode broadcasts and runs the onProxyModeChange hook with the new value', async () => {
    const { reg, broadcasts, proxyModeCalls } = harness();
    const result = (await reg.invoke(
      IPC_CHANNELS.configSet,
      { key: 'proxyMode', value: true },
      trusted,
    )) as PreferencesShape;
    expect(result.proxyMode).toBe(true);
    expect(broadcasts.at(-1)!.payload).toEqual({ theme: 'system', language: 'system', skillsLibrary: 'app', proxyMode: true, warnOnQuitWithProxy: true });
    expect(proxyModeCalls).toEqual([true]);
  });

  it('resetting proxyMode runs the hook with the restored default', async () => {
    const { reg, proxyModeCalls } = harness({ proxyMode: true });
    await reg.invoke(IPC_CHANNELS.configReset, { key: 'proxyMode' }, trusted);
    expect(proxyModeCalls).toEqual([false]);
  });

  it('changing a non-proxyMode preference does not run the proxy-mode hook', async () => {
    const { reg, proxyModeCalls } = harness();
    await reg.invoke(IPC_CHANNELS.configSet, { key: 'theme', value: 'dark' }, trusted);
    expect(proxyModeCalls).toEqual([]);
  });

  it('rejects a non-boolean proxyMode with INVALID_PARAMS', async () => {
    const { reg, proxyModeCalls } = harness();
    expect(await codeOf(() => reg.invoke(IPC_CHANNELS.configSet, { key: 'proxyMode', value: 'yes' }, trusted))).toBe(
      'INVALID_PARAMS',
    );
    expect(proxyModeCalls).toEqual([]);
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
