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
import { WORKBENCH_LIMITS, isValidConversationId, isValidWorkbenchId } from '../../shared/workbench';
import type { WorkbenchManager } from './workbenchManager';

export interface WorkbenchIpcDeps {
  /** Open a main-side folder picker; resolves to the chosen absolute path, or null if cancelled. */
  pickFolder: () => Promise<string | null>;
}

function requireId(raw: unknown, name: string): string {
  if (typeof raw !== 'string' || !isValidWorkbenchId(raw)) throwIpcError('INVALID_PARAMS', `invalid ${name}`);
  return raw;
}

function requireConversationId(raw: unknown): string {
  if (!isValidConversationId(raw)) throwIpcError('INVALID_PARAMS', 'invalid conversationId');
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
    const text = requireText(requireObject(payload).text, 'text', WORKBENCH_LIMITS.chatText);
    await manager.chatSend(text);
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

  registry.register(IPC_CHANNELS.workbenchTaskRunAll, (_payload, meta) => {
    meta.assertTrustedSender();
    manager.runAll();
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchConversationOpen, async (payload, meta) => {
    meta.assertTrustedSender();
    await manager.openConversation(requireConversationId(requireObject(payload).conversationId));
    return snapshot();
  });

  registry.register(IPC_CHANNELS.workbenchConversationDelete, (payload, meta) => {
    meta.assertTrustedSender();
    manager.deleteConversation(requireConversationId(requireObject(payload).conversationId));
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
