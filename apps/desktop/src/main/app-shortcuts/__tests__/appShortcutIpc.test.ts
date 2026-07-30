import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInMemoryRegistry,
  type InMemoryIpcRegistry,
  type IpcInvokeMeta,
} from '../../ipc/registry';
import { throwIpcError } from '../../ipc/validate';
import { registerAppShortcutIpc } from '../appShortcutIpc';
import { AppShortcutStore } from '../AppShortcutStore';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import {
  decodeIpcError,
  isIpcError,
  type IpcErrorCode,
} from '../../../shared/ipc-errors';
import type { AppShortcutCombo } from '../../../shared/appShortcuts';
import type { AppShortcutsMutationResult } from '../../../shared/ipc-channels';

const trusted: IpcInvokeMeta = { assertTrustedSender: () => {} };
const untrusted: IpcInvokeMeta = {
  assertTrustedSender: () => throwIpcError('PERMISSION_DENIED', 'nope'),
};

function mk(code: string, mods: Partial<AppShortcutCombo> = {}): AppShortcutCombo {
  return {
    code,
    meta: Boolean(mods.meta),
    ctrl: Boolean(mods.ctrl),
    alt: Boolean(mods.alt),
    shift: Boolean(mods.shift),
  };
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

describe('app-shortcut IPC', () => {
  let dir: string;
  let reg: InMemoryIpcRegistry;
  let store: AppShortcutStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-shortcuts-ipc-'));
    store = new AppShortcutStore({
      getFilePath: () => path.join(dir, 'app-shortcuts.v1.json'),
      platform: 'darwin',
    });
    reg = createInMemoryRegistry();
    registerAppShortcutIpc(reg, store);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('set-override persists a valid rebind and returns the override set', async () => {
    const result = (await reg.invoke(
      IPC_CHANNELS.appShortcutsSetOverride,
      { id: 'toggle-theme', combo: mk('KeyJ', { meta: true }) },
      trusted,
    )) as AppShortcutsMutationResult;
    expect(result.overrides).toEqual({ 'toggle-theme': mk('KeyJ', { meta: true }) });
  });

  it('clear-override and reset-all return the updated set', async () => {
    store.setOverride('toggle-theme', mk('KeyJ', { meta: true }));
    const cleared = (await reg.invoke(
      IPC_CHANNELS.appShortcutsClearOverride,
      { id: 'toggle-theme' },
      trusted,
    )) as AppShortcutsMutationResult;
    expect(cleared.overrides).toEqual({});

    store.setOverride('check-for-updates', mk('KeyK', { meta: true }));
    const reset = (await reg.invoke(
      IPC_CHANNELS.appShortcutsResetAll,
      undefined,
      trusted,
    )) as AppShortcutsMutationResult;
    expect(reset.overrides).toEqual({});
  });

  it('rejects an untrusted sender before any write', async () => {
    expect(
      await codeOf(() =>
        reg.invoke(
          IPC_CHANNELS.appShortcutsSetOverride,
          { id: 'toggle-theme', combo: mk('KeyJ', { meta: true }) },
          untrusted,
        ),
      ),
    ).toBe('PERMISSION_DENIED');
    expect(store.getOverrides()).toEqual({});
  });

  it('maps store rejections to generic IPC error codes', async () => {
    const set = (id: unknown, combo: unknown) =>
      reg.invoke(IPC_CHANNELS.appShortcutsSetOverride, { id, combo }, trusted);
    expect(await codeOf(() => set('nope', mk('KeyJ', { meta: true })))).toBe('NOT_FOUND');
    expect(await codeOf(() => set('toggle-theme', mk('KeyA')))).toBe('INVALID_PARAMS'); // not-bindable
    expect(await codeOf(() => set('toggle-theme', mk('KeyC', { meta: true })))).toBe('INVALID_PARAMS'); // reserved
    expect(await codeOf(() => set('toggle-theme', mk('KeyU', { meta: true })))).toBe('ALREADY_EXISTS'); // conflict (⌘U = check-for-updates default)
  });

  it('rejects a non-object payload with INVALID_PARAMS', async () => {
    expect(
      await codeOf(() => reg.invoke(IPC_CHANNELS.appShortcutsSetOverride, 'nope', trusted)),
    ).toBe('INVALID_PARAMS');
  });
});
