// Renderer-side workbench store — the single copy of the workbench snapshot the whole
// renderer reads.
//
// Mirrors usageStore: the snapshot is fetched via `workbench.get()` on first use, then kept in
// step by the throttled `workbench:changed` push from main (the orchestrator's streamed reply
// and the workers' polled state both arrive that way). Every mutation returns the fresh
// snapshot, which is applied at once; the broadcast echo re-applies it (idempotent).
//
// The renderer names folders and tasks by the opaque ids main minted — never a path.
//
// The coordinator chat is the exception to "apply as is": a snapshot carries only the newest
// window of it, so the store folds each window into the history it holds (chatHistory.ts) and
// pages older items in on request. `snapshot.chat` is that merged view.

import { DEFAULT_WORKBENCH_SETTINGS, type FilePreview, type FolderListing, type WorkbenchSnapshot } from '../../shared/workbench';
import { EMPTY_CHAT_HISTORY, mergeChatWindow, prependChatPage, type ChatHistory } from './chatHistory';
import type {
  WorkbenchSettingsUpdateRequest,
  WorkbenchTaskCreateRequest,
  WorkbenchTaskUpdateRequest,
} from '../../shared/ipc-channels';

type Listener = () => void;

const EMPTY: WorkbenchSnapshot = {
  status: 'stopped',
  issue: null,
  model: null,
  lastNotify: null,
  streaming: false,
  chat: [],
  chatHasMore: false,
  chatEpoch: 0,
  tasks: [],
  folders: [],
  herdrSession: 'aiopt',
  herdrAvailable: false,
  herdrProbe: {
    installed: false,
    source: null,
    displayPath: null,
    version: null,
    installing: false,
    remote: false,
  },
  conversations: [],
  currentConversationId: null,
  settings: { ...DEFAULT_WORKBENCH_SETTINGS },
};

let snapshot: WorkbenchSnapshot = EMPTY;
let chat: ChatHistory = EMPTY_CHAT_HISTORY;
let version = 0;
let initialized = false;
let olderInFlight: Promise<void> | null = null;
const listeners = new Set<Listener>();

function publish(): void {
  snapshot = { ...snapshot, chat: chat.items, chatHasMore: chat.hasMore, chatEpoch: chat.epoch };
  version += 1;
  listeners.forEach((listener) => listener());
}

function applySnapshot(next: WorkbenchSnapshot): void {
  chat = mergeChatWindow(chat, next.chat, next.chatHasMore, next.chatEpoch);
  snapshot = next;
  publish();
}

/**
 * Page in the items before the oldest one held (the chat pane calls this near its top).
 * One request at a time; a page that went stale in flight (conversation switched) is dropped.
 */
export function loadOlderChat(): Promise<void> {
  ensureInitialized();
  if (olderInFlight) return olderInFlight;
  const first = chat.items[0];
  if (!first || !chat.hasMore) return Promise.resolve();
  olderInFlight = wb()
    .chatPage(first.id)
    .then((page) => {
      const next = prependChatPage(chat, first.id, page);
      if (next !== chat) {
        chat = next;
        publish();
      }
    })
    .finally(() => {
      olderInFlight = null;
    });
  return olderInFlight;
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  window.aiopt.workbench.onChanged(applySnapshot);
  void window.aiopt.workbench.get().then(applySnapshot);
}

/** Subscribe to store changes; returns an unsubscribe fn. */
export function subscribeWorkbenchStore(listener: Listener): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Monotonic version for `useSyncExternalStore` getSnapshot — bumps on every change. */
export function getWorkbenchStoreVersion(): number {
  ensureInitialized();
  return version;
}

export function getWorkbenchSnapshot(): WorkbenchSnapshot {
  ensureInitialized();
  return snapshot;
}

async function apply(call: Promise<WorkbenchSnapshot>): Promise<void> {
  ensureInitialized();
  applySnapshot(await call);
}

const wb = () => window.aiopt.workbench;

export const startWorkbench = (): Promise<void> => apply(wb().start());
export const stopWorkbench = (): Promise<void> => apply(wb().stop());
export const sendChat = (text: string): Promise<void> => apply(wb().send(text));
export const abortChat = (): Promise<void> => apply(wb().abort());
export const resetChat = (): Promise<void> => apply(wb().reset());
/** Opens the main-side folder picker; a cancelled pick leaves the list unchanged. */
export const addFolder = (): Promise<void> => apply(wb().addFolder());
export const removeFolder = (folderId: string): Promise<void> => apply(wb().removeFolder(folderId));
export const createTask = (request: WorkbenchTaskCreateRequest): Promise<void> =>
  apply(wb().createTask(request));
export const updateTask = (request: WorkbenchTaskUpdateRequest): Promise<void> =>
  apply(wb().updateTask(request));
export const launchTask = (taskId: string): Promise<void> => apply(wb().launchTask(taskId));
export const messageTask = (taskId: string, text: string): Promise<void> =>
  apply(wb().messageTask(taskId, text));
export const completeTask = (taskId: string): Promise<void> => apply(wb().completeTask(taskId));
export const stopTask = (taskId: string): Promise<void> => apply(wb().stopTask(taskId));
export const removeTask = (taskId: string): Promise<void> => apply(wb().removeTask(taskId));
/** Launch every proposed task that has a folder (up to the running limit). */
export const runAllTasks = (): Promise<void> => apply(wb().runAll());
export const approveTasks = (taskIds: string[]): Promise<void> => apply(wb().approveTasks(taskIds));
export const runPlan = (conversationId: string): Promise<void> => apply(wb().runPlan(conversationId));
export const openConversation = (conversationId: string): Promise<void> =>
  apply(wb().openConversation(conversationId));
export const deleteConversation = (conversationId: string): Promise<void> =>
  apply(wb().deleteConversation(conversationId));
export const updateWorkbenchSettings = (request: WorkbenchSettingsUpdateRequest): Promise<void> =>
  apply(wb().updateSettings(request));
export const refreshHerdrProbe = (): Promise<void> => apply(wb().refreshHerdrProbe());
export const installHerdr = (): Promise<void> => apply(wb().installHerdr());

/** Read-only listing of one directory inside a granted folder (the file tree). */
export function listFolder(folderId: string, relPath: string): Promise<FolderListing> {
  return wb().listFolder(folderId, relPath);
}

/** Read-only text preview of one file inside a granted folder. */
export function readFolderFile(folderId: string, relPath: string): Promise<FilePreview> {
  return wb().readFolderFile(folderId, relPath);
}

/** Show an entry of a granted folder in the OS file manager. */
export function revealFolderEntry(folderId: string, relPath: string): Promise<void> {
  return wb().revealFolderEntry(folderId, relPath);
}

/** New empty file / directory inside a granted folder's directory; resolves to its relPath. */
export async function createFolderEntry(folderId: string, relPath: string, name: string, kind: 'file' | 'dir'): Promise<string> {
  return (await wb().createFolderEntry(folderId, relPath, name, kind)).relPath;
}

export async function renameFolderEntry(folderId: string, relPath: string, name: string): Promise<string> {
  return (await wb().renameFolderEntry(folderId, relPath, name)).relPath;
}

/** Move an entry to the OS trash. */
export function trashFolderEntry(folderId: string, relPath: string): Promise<void> {
  return wb().trashFolderEntry(folderId, relPath);
}

/** Copy or move an entry into a directory (any granted folder); resolves to the new relPath. */
export async function transferFolderEntry(
  op: 'copy' | 'move',
  from: { folderId: string; relPath: string },
  to: { folderId: string; relPath: string },
): Promise<string> {
  return (await wb().transferFolderEntry({ op, from, to })).relPath;
}

/** Copy files dropped from the OS file manager (main confirms natively first). */
export async function importDroppedFiles(folderId: string, relPath: string, files: readonly File[]): Promise<string[]> {
  return (await wb().importDroppedFiles(folderId, relPath, files)).relPaths;
}

export function copyFolderEntryPath(folderId: string, relPath: string, relative: boolean): Promise<void> {
  return wb().copyFolderEntryPath(folderId, relPath, relative);
}

/** The worker's recent terminal text (already stripped of control characters by main). */
export async function readTaskOutput(taskId: string): Promise<string> {
  return (await wb().taskOutput(taskId)).text;
}
