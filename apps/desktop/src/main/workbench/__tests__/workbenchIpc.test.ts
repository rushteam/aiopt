import { describe, expect, it, vi } from 'vitest';
import { createInMemoryRegistry, type IpcInvokeMeta } from '../../ipc/registry';
import { throwIpcError } from '../../ipc/validate';
import { decodeIpcError } from '../../../shared/ipc-errors';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { WORKBENCH_LIMITS, type WorkbenchSnapshot } from '../../../shared/workbench';
import { registerWorkbenchIpc } from '../workbenchIpc';
import type { WorkbenchManager } from '../workbenchManager';

const trusted: IpcInvokeMeta = { assertTrustedSender: () => {} };
const untrusted: IpcInvokeMeta = {
  assertTrustedSender: () => throwIpcError('PERMISSION_DENIED', 'nope'),
};

const SNAP = { status: 'ready' } as unknown as WorkbenchSnapshot;

function setup(picked: string | null = '/work/app') {
  const manager = {
    getSnapshot: vi.fn(() => SNAP),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    shutdown: vi.fn(),
    chatSend: vi.fn(async () => {}),
    chatAbort: vi.fn(async () => {}),
    chatReset: vi.fn(async () => {}),
    addFolder: vi.fn(async () => {}),
    removeFolder: vi.fn(),
    createTask: vi.fn(() => 'id1'),
    updateTask: vi.fn(),
    launchTask: vi.fn(),
    messageTask: vi.fn(async () => {}),
    completeTask: vi.fn(async () => {}),
    stopTask: vi.fn(async () => {}),
    removeTask: vi.fn(async () => {}),
    taskOutput: vi.fn(async () => 'out'),
    runAll: vi.fn(() => 0),
    openConversation: vi.fn(async () => {}),
    deleteConversation: vi.fn(),
    updateSettings: vi.fn(),
  } satisfies WorkbenchManager;
  const pickFolder = vi.fn(async () => picked);
  const reg = createInMemoryRegistry();
  registerWorkbenchIpc(reg, manager, { pickFolder });
  return { reg, manager, pickFolder };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return decodeIpcError((err as Error).message).code;
  }
  return 'none';
}

const CHANNELS = Object.entries(IPC_CHANNELS).filter(([key]) => key.startsWith('workbench'));

describe('workbench ipc', () => {
  it('registers every workbench channel and asserts the trusted sender first', async () => {
    const { reg, manager, pickFolder } = setup();
    expect(CHANNELS).toHaveLength(20);
    for (const [, channel] of CHANNELS) {
      expect(await codeOf(reg.invoke(channel, { taskId: 'id1', folderId: 'id1', text: 'x' }, untrusted))).toBe(
        'PERMISSION_DENIED',
      );
    }
    expect(pickFolder).not.toHaveBeenCalled();
    for (const fn of Object.values(manager)) expect(fn).not.toHaveBeenCalled();
  });

  it('adds only the folder picked in main, ignoring any path in the payload', async () => {
    const { reg, manager } = setup();
    await reg.invoke(IPC_CHANNELS.workbenchFolderAdd, { path: '/etc' }, trusted);
    expect(manager.addFolder).toHaveBeenCalledWith('/work/app');

    const cancelled = setup(null);
    await cancelled.reg.invoke(IPC_CHANNELS.workbenchFolderAdd, undefined, trusted);
    expect(cancelled.manager.addFolder).not.toHaveBeenCalled();
  });

  it('rejects malformed ids and oversized text before the manager runs', async () => {
    const { reg, manager } = setup();
    expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchTaskLaunch, { taskId: '../x' }, trusted))).toBe('INVALID_PARAMS');
    expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchTaskStop, { taskId: 7 }, trusted))).toBe('INVALID_PARAMS');
    expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchFolderRemove, { folderId: 'A B' }, trusted))).toBe(
      'INVALID_PARAMS',
    );
    expect(
      await codeOf(
        reg.invoke(IPC_CHANNELS.workbenchChatSend, { text: 'x'.repeat(WORKBENCH_LIMITS.chatText + 1) }, trusted),
      ),
    ).toBe('INVALID_PARAMS');
    expect(
      await codeOf(
        reg.invoke(IPC_CHANNELS.workbenchTaskCreate, { title: 't', prompt: 'p', folderId: 'id1', isolated: 'yes' }, trusted),
      ),
    ).toBe('INVALID_PARAMS');
    expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchTaskCreate, null, trusted))).toBe('INVALID_PARAMS');
    expect(manager.launchTask).not.toHaveBeenCalled();
    expect(manager.chatSend).not.toHaveBeenCalled();
    expect(manager.createTask).not.toHaveBeenCalled();
  });

  it('passes validated payloads through and returns the snapshot', async () => {
    const { reg, manager } = setup();
    expect(
      await reg.invoke(IPC_CHANNELS.workbenchTaskCreate, { title: 't', prompt: 'p', folderId: null, isolated: true }, trusted),
    ).toBe(SNAP);
    expect(manager.createTask).toHaveBeenCalledWith({ title: 't', prompt: 'p', folderId: null, isolated: true });

    await reg.invoke(IPC_CHANNELS.workbenchTaskUpdate, { taskId: 'id1', prompt: 'q' }, trusted);
    expect(manager.updateTask).toHaveBeenCalledWith('id1', {
      title: undefined,
      prompt: 'q',
      folderId: undefined,
      isolated: undefined,
    });

    await reg.invoke(IPC_CHANNELS.workbenchTaskMessage, { taskId: 'id1', text: 'go on' }, trusted);
    expect(manager.messageTask).toHaveBeenCalledWith('id1', 'go on');
    expect(await reg.invoke(IPC_CHANNELS.workbenchTaskOutput, { taskId: 'id1' }, trusted)).toEqual({ text: 'out' });

    expect(await reg.invoke(IPC_CHANNELS.workbenchTaskRunAll, undefined, trusted)).toBe(SNAP);
    expect(manager.runAll).toHaveBeenCalledTimes(1);
  });

  it('takes only a session uuid for a conversation, never a path', async () => {
    const { reg, manager } = setup();
    const id = '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
    await reg.invoke(IPC_CHANNELS.workbenchConversationOpen, { conversationId: id }, trusted);
    expect(manager.openConversation).toHaveBeenCalledWith(id);
    await reg.invoke(IPC_CHANNELS.workbenchConversationDelete, { conversationId: id }, trusted);
    expect(manager.deleteConversation).toHaveBeenCalledWith(id);

    for (const bad of ['/u/.ssh/id_rsa', `../${id}`, `${id}.jsonl`, id.toUpperCase(), 7, null]) {
      expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchConversationOpen, { conversationId: bad }, trusted))).toBe(
        'INVALID_PARAMS',
      );
      expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchConversationDelete, { conversationId: bad }, trusted))).toBe(
        'INVALID_PARAMS',
      );
    }
    expect(manager.openConversation).toHaveBeenCalledTimes(1);
    expect(manager.deleteConversation).toHaveBeenCalledTimes(1);
  });

  it('accepts only boolean settings', async () => {
    const { reg, manager } = setup();
    await reg.invoke(IPC_CHANNELS.workbenchSettingsUpdate, { autoRun: true }, trusted);
    expect(manager.updateSettings).toHaveBeenCalledWith({ autoRun: true, notifyCoordinator: undefined });
    expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchSettingsUpdate, { autoRun: 'yes' }, trusted))).toBe(
      'INVALID_PARAMS',
    );
    expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchSettingsUpdate, { notifyCoordinator: 1 }, trusted))).toBe(
      'INVALID_PARAMS',
    );
    expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchSettingsUpdate, null, trusted))).toBe('INVALID_PARAMS');
    expect(manager.updateSettings).toHaveBeenCalledTimes(1);
  });
});
