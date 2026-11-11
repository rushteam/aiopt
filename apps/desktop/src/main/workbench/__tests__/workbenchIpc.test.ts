import { describe, expect, it, vi } from 'vitest';
import { createInMemoryRegistry, type IpcInvokeMeta } from '../../ipc/registry';
import { throwIpcError } from '../../ipc/validate';
import { decodeIpcError } from '../../../shared/ipc-errors';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { WORKBENCH_LIMITS, type WorkbenchSnapshot } from '../../../shared/workbench';
import { registerWorkbenchIpc } from '../workbenchIpc';
import type { FolderOps } from '../folderOps';
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
    listFolder: vi.fn(() => ({ entries: [{ name: 'src', kind: 'dir' as const }], truncated: false })),
    readFolderFile: vi.fn(() => ({ text: 'hi', truncated: false, binary: false, size: 2 })),
    resolveFolderEntry: vi.fn(() => '/work/app/src/a.ts'),
    folderRoot: vi.fn(() => ({ root: '/work/app', name: 'app' })),
    createTask: vi.fn(() => 'id1'),
    updateTask: vi.fn(),
    launchTask: vi.fn(),
    messageTask: vi.fn(async () => {}),
    completeTask: vi.fn(async () => {}),
    stopTask: vi.fn(async () => {}),
    removeTask: vi.fn(async () => {}),
    taskOutput: vi.fn(async () => 'out'),
    taskChanges: vi.fn(async () => ({ since: 'launch' as const, files: [], truncated: false })),
    runAll: vi.fn(() => 0),
    approveTasks: vi.fn(),
    runPlan: vi.fn(),
    openConversation: vi.fn(async () => {}),
    chatPage: vi.fn(() => ({ items: [], hasMore: false, epoch: 0 })),
    deleteConversation: vi.fn(),
    searchConversations: vi.fn((query: string) => ({ query, hits: [] })),
    timeline: vi.fn(() => []),
    renameConversation: vi.fn(),
    updateSettings: vi.fn(),
    refreshHerdrProbe: vi.fn(async () => {}),
    installHerdr: vi.fn(async () => {}),
  } satisfies WorkbenchManager;
  const pickFolder = vi.fn(async () => picked);
  const revealItem = vi.fn();
  const folderOps = {
    create: vi.fn(() => 'src/new.ts'),
    rename: vi.fn(() => 'src/b.ts'),
    trash: vi.fn(async () => {}),
    transfer: vi.fn(() => 'lib/a.ts'),
    importPaths: vi.fn(async () => ['in.txt']),
    copyPath: vi.fn(),
  } satisfies FolderOps;
  const reg = createInMemoryRegistry();
  registerWorkbenchIpc(reg, manager, { pickFolder, revealItem, folderOps });
  return { reg, manager, pickFolder, revealItem, folderOps };
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
    const { reg, manager, pickFolder, revealItem, folderOps } = setup();
    expect(CHANNELS).toHaveLength(38);
    for (const [, channel] of CHANNELS) {
      expect(await codeOf(reg.invoke(channel, { taskId: 'id1', folderId: 'id1', text: 'x' }, untrusted))).toBe(
        'PERMISSION_DENIED',
      );
    }
    expect(pickFolder).not.toHaveBeenCalled();
    expect(revealItem).not.toHaveBeenCalled();
    for (const fn of Object.values(manager)) expect(fn).not.toHaveBeenCalled();
    for (const fn of Object.values(folderOps)) expect(fn).not.toHaveBeenCalled();
  });

  it('routes explorer file operations by id plus relative paths, validating before folderOps runs', async () => {
    const { reg, folderOps } = setup();
    expect(
      await reg.invoke(IPC_CHANNELS.workbenchFolderCreate, { folderId: 'f1', relPath: 'src', name: 'new.ts', kind: 'file' }, trusted),
    ).toEqual({ relPath: 'src/new.ts' });
    expect(folderOps.create).toHaveBeenCalledWith('f1', 'src', 'new.ts', 'file');
    expect(await reg.invoke(IPC_CHANNELS.workbenchFolderRename, { folderId: 'f1', relPath: 'src/a.ts', name: 'b.ts' }, trusted)).toEqual({
      relPath: 'src/b.ts',
    });
    await reg.invoke(IPC_CHANNELS.workbenchFolderTrash, { folderId: 'f1', relPath: 'src/a.ts' }, trusted);
    expect(folderOps.trash).toHaveBeenCalledWith('f1', 'src/a.ts');
    const transfer = { op: 'move', from: { folderId: 'f1', relPath: 'src/a.ts' }, to: { folderId: 'f2', relPath: 'lib' } };
    expect(await reg.invoke(IPC_CHANNELS.workbenchFolderTransfer, transfer, trusted)).toEqual({ relPath: 'lib/a.ts' });
    expect(folderOps.transfer).toHaveBeenCalledWith('move', transfer.from, transfer.to);
    expect(await reg.invoke(IPC_CHANNELS.workbenchFolderImport, { folderId: 'f1', relPath: '', paths: ['/tmp/in.txt'] }, trusted)).toEqual({
      relPaths: ['in.txt'],
    });
    await reg.invoke(IPC_CHANNELS.workbenchFolderCopyPath, { folderId: 'f1', relPath: 'src', relative: true }, trusted);
    expect(folderOps.copyPath).toHaveBeenCalledWith('f1', 'src', true);

    const bad: [string, unknown][] = [
      [IPC_CHANNELS.workbenchFolderCreate, { folderId: 'f1', relPath: '', name: '../x', kind: 'file' }],
      [IPC_CHANNELS.workbenchFolderCreate, { folderId: 'f1', relPath: '', name: 'a/b', kind: 'file' }],
      [IPC_CHANNELS.workbenchFolderCreate, { folderId: 'f1', relPath: '', name: 'x', kind: 'link' }],
      [IPC_CHANNELS.workbenchFolderRename, { folderId: 'f1', relPath: '../a', name: 'b' }],
      [IPC_CHANNELS.workbenchFolderRename, { folderId: 'f1', relPath: 'a', name: '..' }],
      [IPC_CHANNELS.workbenchFolderTrash, { folderId: 'f1', relPath: '/etc/passwd' }],
      [IPC_CHANNELS.workbenchFolderTransfer, { op: 'link', from: transfer.from, to: transfer.to }],
      [IPC_CHANNELS.workbenchFolderTransfer, { op: 'copy', from: { folderId: 'f1', relPath: '../../x' }, to: transfer.to }],
      [IPC_CHANNELS.workbenchFolderTransfer, { op: 'copy', from: transfer.from, to: { folderId: 'A B', relPath: '' } }],
      [IPC_CHANNELS.workbenchFolderImport, { folderId: 'f1', relPath: '', paths: [] }],
      [IPC_CHANNELS.workbenchFolderImport, { folderId: 'f1', relPath: '', paths: 'x' }],
      [IPC_CHANNELS.workbenchFolderImport, { folderId: 'f1', relPath: '', paths: [7] }],
      [IPC_CHANNELS.workbenchFolderImport, { folderId: 'f1', relPath: '', paths: ['/a\u0000b'] }],
      [IPC_CHANNELS.workbenchFolderImport, { folderId: 'f1', relPath: '', paths: Array.from({ length: 51 }, (_, i) => `/p${i}`) }],
      [IPC_CHANNELS.workbenchFolderCopyPath, { folderId: 'f1', relPath: '', relative: 'yes' }],
    ];
    for (const [channel, payload] of bad) {
      expect(await codeOf(reg.invoke(channel, payload, trusted))).toBe('INVALID_PARAMS');
    }
    expect(folderOps.create).toHaveBeenCalledTimes(1);
    expect(folderOps.rename).toHaveBeenCalledTimes(1);
    expect(folderOps.trash).toHaveBeenCalledTimes(1);
    expect(folderOps.transfer).toHaveBeenCalledTimes(1);
    expect(folderOps.importPaths).toHaveBeenCalledTimes(1);
    expect(folderOps.copyPath).toHaveBeenCalledTimes(1);
  });

  it('adds only the folder picked in main, ignoring any path in the payload', async () => {
    const { reg, manager } = setup();
    await reg.invoke(IPC_CHANNELS.workbenchFolderAdd, { path: '/etc' }, trusted);
    expect(manager.addFolder).toHaveBeenCalledWith('/work/app');

    const cancelled = setup(null);
    await cancelled.reg.invoke(IPC_CHANNELS.workbenchFolderAdd, undefined, trusted);
    expect(cancelled.manager.addFolder).not.toHaveBeenCalled();
  });

  it('lists a folder by id plus a relative path, refusing a path that escapes before the manager runs', async () => {
    const { reg, manager } = setup();
    expect(await reg.invoke(IPC_CHANNELS.workbenchFolderList, { folderId: 'f1', relPath: 'src/lib' }, trusted)).toEqual({
      entries: [{ name: 'src', kind: 'dir' }],
      truncated: false,
    });
    expect(manager.listFolder).toHaveBeenCalledWith('f1', 'src/lib');
    for (const relPath of ['..', 'a/../..', '/etc', 'C:\\x', 'a//b', 'a\\..', 7, undefined]) {
      expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchFolderList, { folderId: 'f1', relPath }, trusted))).toBe(
        'INVALID_PARAMS',
      );
    }
    expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchFolderList, { folderId: '../x', relPath: '' }, trusted))).toBe(
      'INVALID_PARAMS',
    );
    expect(manager.listFolder).toHaveBeenCalledTimes(1);
  });

  it('previews and reveals a folder entry by id plus a relative path, never a renderer path', async () => {
    const { reg, manager, revealItem } = setup();
    expect(await reg.invoke(IPC_CHANNELS.workbenchFolderRead, { folderId: 'f1', relPath: 'src/a.ts' }, trusted)).toEqual({
      text: 'hi',
      truncated: false,
      binary: false,
      size: 2,
    });
    expect(manager.readFolderFile).toHaveBeenCalledWith('f1', 'src/a.ts');
    await reg.invoke(IPC_CHANNELS.workbenchFolderReveal, { folderId: 'f1', relPath: 'src/a.ts' }, trusted);
    expect(manager.resolveFolderEntry).toHaveBeenCalledWith('f1', 'src/a.ts');
    // Main reveals the path the MANAGER resolved; the payload carries none.
    expect(revealItem).toHaveBeenCalledWith('/work/app/src/a.ts');
    for (const channel of [IPC_CHANNELS.workbenchFolderRead, IPC_CHANNELS.workbenchFolderReveal]) {
      for (const relPath of ['..', '/etc/passwd', 'a/../../b', 'a\\b', 7]) {
        expect(await codeOf(reg.invoke(channel, { folderId: 'f1', relPath }, trusted))).toBe('INVALID_PARAMS');
      }
      expect(await codeOf(reg.invoke(channel, { folderId: '../x', relPath: 'a' }, trusted))).toBe('INVALID_PARAMS');
    }
    expect(manager.readFolderFile).toHaveBeenCalledTimes(1);
    expect(revealItem).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed ids and oversized text before the manager runs', async () => {
    const { reg, manager } = setup();
    expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchTaskLaunch, { taskId: '../x' }, trusted))).toBe('INVALID_PARAMS');
    expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchTaskStop, { taskId: 7 }, trusted))).toBe('INVALID_PARAMS');
    expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchTaskChanges, { taskId: '/etc' }, trusted))).toBe(
      'INVALID_PARAMS',
    );
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
    expect(
      await codeOf(
        reg.invoke(IPC_CHANNELS.workbenchChatSend, { text: 'x', images: [{ mimeType: 'text/html', data: 'PGI+' }] }, trusted),
      ),
    ).toBe('INVALID_PARAMS');
    expect(manager.launchTask).not.toHaveBeenCalled();
    expect(manager.chatSend).not.toHaveBeenCalled();
    expect(manager.createTask).not.toHaveBeenCalled();
  });

  it('pages chat history by a bounded item id', async () => {
    const { reg, manager } = setup();
    expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchChatPage, { beforeId: 7 }, trusted))).toBe('INVALID_PARAMS');
    expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchChatPage, { beforeId: '' }, trusted))).toBe('INVALID_PARAMS');
    expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchChatPage, { beforeId: 'x'.repeat(129) }, trusted))).toBe(
      'INVALID_PARAMS',
    );
    expect(manager.chatPage).not.toHaveBeenCalled();
    expect(await reg.invoke(IPC_CHANNELS.workbenchChatPage, { beforeId: 'c12' }, trusted)).toEqual({
      items: [],
      hasMore: false,
      epoch: 0,
    });
    expect(manager.chatPage).toHaveBeenCalledWith('c12');
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
    // Only the task id reaches the manager: a path in the payload is ignored.
    await reg.invoke(IPC_CHANNELS.workbenchTaskChanges, { taskId: 'id1', path: '/etc' }, trusted);
    expect(manager.taskChanges).toHaveBeenCalledWith('id1');

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

    await reg.invoke(IPC_CHANNELS.workbenchConversationRename, { conversationId: id, title: 'Release notes' }, trusted);
    expect(manager.renameConversation).toHaveBeenCalledWith(id, 'Release notes');
    await reg.invoke(IPC_CHANNELS.workbenchConversationRename, { conversationId: id, title: '' }, trusted);
    expect(manager.renameConversation).toHaveBeenLastCalledWith(id, '');
    for (const bad of [{ conversationId: '../x', title: 'a' }, { conversationId: id }, { conversationId: id, title: 'x'.repeat(321) }]) {
      expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchConversationRename, bad, trusted))).toBe('INVALID_PARAMS');
    }
    expect(manager.renameConversation).toHaveBeenCalledTimes(2);
  });

  it('searches conversations by text only, with a capped query', async () => {
    const { reg, manager } = setup();
    expect(await reg.invoke(IPC_CHANNELS.workbenchConversationSearch, { query: 'release' }, trusted)).toEqual({
      query: 'release',
      hits: [],
    });
    expect(manager.searchConversations).toHaveBeenCalledWith('release');
    for (const bad of [{}, { query: 7 }, { query: 'x'.repeat(201) }]) {
      expect(await codeOf(reg.invoke(IPC_CHANNELS.workbenchConversationSearch, bad, trusted))).toBe('INVALID_PARAMS');
    }
    expect(manager.searchConversations).toHaveBeenCalledTimes(1);
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
