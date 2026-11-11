// Workbench IPC — the renderer-facing surface of the workbench manager.
//
// The operations behind it start processes and let agents act in the user's folders, so the
// discipline is the security rule §5 to the letter: authorize the sender FIRST, then validate
// the payload shape at runtime BEFORE anything runs. The renderer names folders and tasks by
// the opaque ids main minted; it never supplies a path, a command line, or an agent name. A
// folder is granted only through the main-side picker (injected `pickFolder`). Text limits and
// control-character stripping are applied again in the manager, where the text is used.

import type { IpcHandlerRegistry } from '../ipc/registry';
import { requireObject, requireString, throwIpcError } from '../ipc/validate';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { requireChatImages } from './chatImages';
import {
  WORKBENCH_LIMITS,
  isValidConversationId,
  isValidFolderRelPath,
  isValidFolderSegment,
  isValidWorkbenchId,
} from '../../shared/workbench';
import type { WorkbenchManager } from './workbenchManager';
import type { FolderOps } from './folderOps';

export interface WorkbenchIpcDeps {
  /** Open a main-side folder picker; resolves to the chosen absolute path, or null if cancelled. */
  pickFolder: () => Promise<string | null>;
  /**
   * Show an absolute path in the OS file manager (`shell.showItemInFolder`). Only ever a path
   * the MANAGER resolved and confined to a granted folder — never one the renderer supplied.
   */
  revealItem: (absolutePath: string) => void;
  /** The explorer's file operations (folderOps.ts): confined to granted folders, never overwrite. */
  folderOps: FolderOps;
}

/** `{folderId, relPath}` of a folder entry, shape-checked (the manager confines it). */
function requireFolderEntry(payload: unknown): { folderId: string; relPath: string } {
  const obj = requireObject(payload);
  const folderId = requireId(obj.folderId, 'folderId');
  if (!isValidFolderRelPath(obj.relPath)) throwIpcError('INVALID_PARAMS', 'invalid relPath');
  return { folderId, relPath: obj.relPath };
}

/** A new entry's name: one path segment (folderOps re-checks hidden / platform rules). */
function requireSegment(raw: unknown): string {
  if (typeof raw !== 'string' || !isValidFolderSegment(raw)) throwIpcError('INVALID_PARAMS', 'invalid name');
  return raw;
}

/** Absolute paths dropped from the OS file manager: a bounded list of bounded strings. */
function requireDropPaths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > WORKBENCH_LIMITS.importPaths) {
    throwIpcError('INVALID_PARAMS', 'invalid paths');
  }
  return raw.map((p) => {
    // eslint-disable-next-line no-control-regex
    if (typeof p !== 'string' || p.length === 0 || p.length > WORKBENCH_LIMITS.importPathChars || /[\u0000-\u001f]/.test(p)) {
      throwIpcError('INVALID_PARAMS', 'invalid path');
    }
    return p;
  });
}

function requireId(raw: unknown, name: string): string {
  if (typeof raw !== 'string' || !isValidWorkbenchId(raw)) throwIpcError('INVALID_PARAMS', `invalid ${name}`);
  return raw;
}

function requireConversationId(raw: unknown): string {
  if (!isValidConversationId(raw)) throwIpcError('INVALID_PARAMS', 'invalid conversationId');
  return raw;
}

/** A transcript item id: `c<n>` minted by the reducer, or a tool-call id pi reported. */
function requireChatItemId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) throwIpcError('INVALID_PARAMS', 'invalid beforeId');
  return raw;
}

function requireText(raw: unknown, name: string, max: number): string {
  const text = requireString(raw, name);
  if (text.length > max) throwIpcError('INVALID_PARAMS', `${name} is too long`);
  return text;
}

function optionalText(raw: unknown, name: string, max: number): string | undefined {
  return raw === undefined ? undefined : requireText(raw, name, max);
}

function optionalFolderId(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return requireId(raw, 'folderId');
}

function optionalBoolean(raw: unknown, name: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') throwIpcError('INVALID_PARAMS', `${name} must be a boolean`);
  return raw;
}

/** A non-empty, de-duplicated list of task ids, at most one proposal's worth. */
function requireTaskIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throwIpcError('INVALID_PARAMS', 'taskIds must be a non-empty array');
  const out: string[] = [];
  for (const id of raw) {
    if (!isValidWorkbenchId(id)) throwIpcError('INVALID_PARAMS', 'invalid task id');
    if (!out.includes(id)) out.push(id);
    if (out.length > WORKBENCH_LIMITS.tasksPerProposal) throwIpcError('INVALID_PARAMS', 'too many task ids');
  }
  return out;
}

function optionalDependsOn(raw: unknown): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!Array.isArray(raw)) throwIpcError('INVALID_PARAMS', 'dependsOn must be an array');
  const out: string[] = [];
  for (const id of raw) {
    if (!isValidWorkbenchId(id)) throwIpcError('INVALID_PARAMS', 'invalid dependsOn id');
    if (!out.includes(id)) out.push(id);
    if (out.length > WORKBENCH_LIMITS.tasksPerProposal) throwIpcError('INVALID_PARAMS', 'dependsOn is too long');
  }
  return out;
}

export function registerWorkbenchIpc(
  registry: IpcHandlerRegistry,
  manager: WorkbenchManager,
  deps: WorkbenchIpcDeps,
): void {
  const snapshot = () => manager.getSnapshot();
  const taskId = (payload: unknown) => requireId(requireObject(payload).taskId, 'taskId');

  registry.register(IPC_CHANNELS.workbenchGet, (_payload, meta) => {
    meta.assertTrustedSender();
    void manager.refreshHerdrProbe();
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchHerdrProbe, async (_payload, meta) => {
    meta.assertTrustedSender();
    await manager.refreshHerdrProbe();
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchHerdrInstall, async (_payload, meta) => {
    meta.assertTrustedSender();
    await manager.installHerdr();
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchStart, async (_payload, meta) => {
    meta.assertTrustedSender();
    await manager.start();
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchStop, async (_payload, meta) => {
    meta.assertTrustedSender();
    await manager.stop();
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchChatSend, async (payload, meta) => {
    meta.assertTrustedSender();
    const body = requireObject(payload);
    const text = requireText(body.text, 'text', WORKBENCH_LIMITS.chatText);
    await manager.chatSend(text, requireChatImages(body.images));
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchChatAbort, async (_payload, meta) => {
    meta.assertTrustedSender();
    await manager.chatAbort();
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchChatReset, async (_payload, meta) => {
    meta.assertTrustedSender();
    await manager.chatReset();
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchFolderAdd, async (_payload, meta) => {
    meta.assertTrustedSender();
    // The folder is chosen in MAIN — never supplied by the renderer.
    const dir = await deps.pickFolder();
    if (dir !== null) await manager.addFolder(dir);
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchFolderRemove, (payload, meta) => {
    meta.assertTrustedSender();
    manager.removeFolder(requireId(requireObject(payload).folderId, 'folderId'));
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchFolderList, (payload, meta) => {
    meta.assertTrustedSender();
    // Shape only; the manager resolves it and confines it to the granted folder.
    const { folderId, relPath } = requireFolderEntry(payload);
    return manager.listFolder(folderId, relPath);
  });

  registry.register(IPC_CHANNELS.workbenchFolderRead, (payload, meta) => {
    meta.assertTrustedSender();
    const { folderId, relPath } = requireFolderEntry(payload);
    return manager.readFolderFile(folderId, relPath);
  });

  registry.register(IPC_CHANNELS.workbenchFolderReveal, (payload, meta) => {
    meta.assertTrustedSender();
    const { folderId, relPath } = requireFolderEntry(payload);
    // Reveal only: the file manager selects the entry, it never opens or runs it.
    deps.revealItem(manager.resolveFolderEntry(folderId, relPath));
  });

  registry.register(IPC_CHANNELS.workbenchFolderCreate, (payload, meta) => {
    meta.assertTrustedSender();
    const { folderId, relPath } = requireFolderEntry(payload);
    const obj = requireObject(payload);
    const name = requireSegment(obj.name);
    if (obj.kind !== 'file' && obj.kind !== 'dir') throwIpcError('INVALID_PARAMS', 'invalid kind');
    return { relPath: deps.folderOps.create(folderId, relPath, name, obj.kind) };
  });

  registry.register(IPC_CHANNELS.workbenchFolderRename, (payload, meta) => {
    meta.assertTrustedSender();
    const { folderId, relPath } = requireFolderEntry(payload);
    const name = requireSegment(requireObject(payload).name);
    return { relPath: deps.folderOps.rename(folderId, relPath, name) };
  });

  registry.register(IPC_CHANNELS.workbenchFolderTrash, async (payload, meta) => {
    meta.assertTrustedSender();
    const { folderId, relPath } = requireFolderEntry(payload);
    // Move to the OS trash only; there is no permanent delete.
    await deps.folderOps.trash(folderId, relPath);
  });

  registry.register(IPC_CHANNELS.workbenchFolderTransfer, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    if (obj.op !== 'copy' && obj.op !== 'move') throwIpcError('INVALID_PARAMS', 'invalid op');
    const from = requireFolderEntry(obj.from);
    const to = requireFolderEntry(obj.to);
    return { relPath: deps.folderOps.transfer(obj.op, from, to) };
  });

  registry.register(IPC_CHANNELS.workbenchFolderImport, async (payload, meta) => {
    meta.assertTrustedSender();
    const { folderId, relPath } = requireFolderEntry(payload);
    const paths = requireDropPaths(requireObject(payload).paths);
    // folderOps shows a native confirmation before anything is copied.
    return { relPaths: await deps.folderOps.importPaths(folderId, relPath, paths) };
  });

  registry.register(IPC_CHANNELS.workbenchFolderCopyPath, (payload, meta) => {
    meta.assertTrustedSender();
    const { folderId, relPath } = requireFolderEntry(payload);
    const relative = requireObject(payload).relative;
    if (typeof relative !== 'boolean') throwIpcError('INVALID_PARAMS', 'invalid relative');
    deps.folderOps.copyPath(folderId, relPath, relative);
  });

  registry.register(IPC_CHANNELS.workbenchTaskCreate, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    manager.createTask({
      title: requireText(obj.title, 'title', WORKBENCH_LIMITS.taskTitle),
      prompt: requireText(obj.prompt, 'prompt', WORKBENCH_LIMITS.taskPrompt),
      folderId: optionalFolderId(obj.folderId) ?? null,
      isolated: optionalBoolean(obj.isolated, 'isolated') ?? false,
    });
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchTaskUpdate, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const id = requireId(obj.taskId, 'taskId');
    manager.updateTask(id, {
      title: optionalText(obj.title, 'title', WORKBENCH_LIMITS.taskTitle),
      prompt: optionalText(obj.prompt, 'prompt', WORKBENCH_LIMITS.taskPrompt),
      folderId: optionalFolderId(obj.folderId),
      isolated: optionalBoolean(obj.isolated, 'isolated'),
      dependsOn: optionalDependsOn(obj.dependsOn),
    });
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchTaskLaunch, (payload, meta) => {
    meta.assertTrustedSender();
    manager.launchTask(taskId(payload));
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchTaskMessage, async (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const id = requireId(obj.taskId, 'taskId');
    await manager.messageTask(id, requireText(obj.text, 'text', WORKBENCH_LIMITS.taskPrompt));
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchTaskComplete, async (payload, meta) => {
    meta.assertTrustedSender();
    await manager.completeTask(taskId(payload));
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchTaskStop, async (payload, meta) => {
    meta.assertTrustedSender();
    await manager.stopTask(taskId(payload));
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchTaskRemove, async (payload, meta) => {
    meta.assertTrustedSender();
    await manager.removeTask(taskId(payload));
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchTaskOutput, async (payload, meta) => {
    meta.assertTrustedSender();
    return { text: await manager.taskOutput(taskId(payload)) };
  });

  // Read-only: main picks the checkout from its own task record (never a renderer path).
  registry.register(IPC_CHANNELS.workbenchTaskChanges, async (payload, meta) => {
    meta.assertTrustedSender();
    return manager.taskChanges(taskId(payload));
  });

  registry.register(IPC_CHANNELS.workbenchTaskRunAll, (_payload, meta) => {
    meta.assertTrustedSender();
    manager.runAll();
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchTaskApprove, (payload, meta) => {
    meta.assertTrustedSender();
    manager.approveTasks(requireTaskIds(requireObject(payload).taskIds));
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchPlanRun, (payload, meta) => {
    meta.assertTrustedSender();
    manager.runPlan(requireConversationId(requireObject(payload).conversationId));
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchConversationOpen, async (payload, meta) => {
    meta.assertTrustedSender();
    await manager.openConversation(requireConversationId(requireObject(payload).conversationId));
    return snapshot();
  });

  // Read-only: a slice of the in-memory transcript. The id is only looked up, never used as a path.
  registry.register(IPC_CHANNELS.workbenchChatPage, (payload, meta) => {
    meta.assertTrustedSender();
    return manager.chatPage(requireChatItemId(requireObject(payload).beforeId));
  });

  registry.register(IPC_CHANNELS.workbenchConversationDelete, (payload, meta) => {
    meta.assertTrustedSender();
    manager.deleteConversation(requireConversationId(requireObject(payload).conversationId));
    return snapshot();
  });

  // Read-only: main searches the conversations it listed itself; the renderer sends only text.
  registry.register(IPC_CHANNELS.workbenchConversationSearch, (payload, meta) => {
    meta.assertTrustedSender();
    const query = requireObject(payload).query;
    if (typeof query !== 'string') throwIpcError('INVALID_PARAMS', 'query is required');
    if (query.length > WORKBENCH_LIMITS.searchQuery) throwIpcError('INVALID_PARAMS', 'query is too long');
    return manager.searchConversations(query);
  });

  // Read-only display data (ids, titles, statuses, times); takes no payload.
  registry.register(IPC_CHANNELS.workbenchTimeline, (_payload, meta) => {
    meta.assertTrustedSender();
    return manager.timeline();
  });

  registry.register(IPC_CHANNELS.workbenchConversationRename, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const conversationId = requireConversationId(obj.conversationId);
    // '' is allowed: it drops the user's title and goes back to the first message.
    if (typeof obj.title !== 'string') throwIpcError('INVALID_PARAMS', 'title is required');
    // A paste can run a little long; anything past a few titles' worth is not a title.
    if (obj.title.length > WORKBENCH_LIMITS.conversationTitle * 4) throwIpcError('INVALID_PARAMS', 'title is too long');
    manager.renameConversation(conversationId, obj.title);
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchSettingsUpdate, (payload, meta) => {
    meta.assertTrustedSender();
    const obj = requireObject(payload);
    const sshRaw = obj.herdrSshTarget;
    let herdrSshTarget: string | null | undefined;
    if (sshRaw !== undefined) {
      if (sshRaw === null) herdrSshTarget = null;
      else if (typeof sshRaw === 'string') herdrSshTarget = sshRaw.trim() === '' ? null : sshRaw.trim();
      else throwIpcError('INVALID_PARAMS', 'herdrSshTarget must be a string');
    }
    manager.updateSettings({
      autoRun: optionalBoolean(obj.autoRun, 'autoRun'),
      notifyCoordinator: optionalBoolean(obj.notifyCoordinator, 'notifyCoordinator'),
      autoLaunchDependents: optionalBoolean(obj.autoLaunchDependents, 'autoLaunchDependents'),
      herdrSshTarget,
    });
    return snapshot();
  });
}
