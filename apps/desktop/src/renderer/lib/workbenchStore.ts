// Renderer-side workbench store — the single copy of the workbench snapshot the whole
// renderer reads.
//
// Mirrors usageStore: the snapshot is fetched via `workbench.get()` on first use, then kept in
// step by the throttled `workbench:changed` push from main (the orchestrator's streamed reply
// and the workers' polled state both arrive that way). Every mutation returns the fresh
// snapshot, which is applied at once; the broadcast echo re-applies it (idempotent).
//
// The renderer names folders and tasks by the opaque ids main minted — never a path.

import { DEFAULT_WORKBENCH_SETTINGS, type WorkbenchSnapshot } from '../../shared/workbench';
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
  streaming: false,
  chat: [],
  tasks: [],
  folders: [],
  herdrSession: 'aiopt',
  herdrAvailable: false,
  conversations: [],
  settings: { ...DEFAULT_WORKBENCH_SETTINGS },
};

let snapshot: WorkbenchSnapshot = EMPTY;
let version = 0;
let initialized = false;
const listeners = new Set<Listener>();

function applySnapshot(next: WorkbenchSnapshot): void {
  snapshot = next;
  version += 1;
  listeners.forEach((listener) => listener());
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
export const openConversation = (conversationId: string): Promise<void> =>
  apply(wb().openConversation(conversationId));
export const deleteConversation = (conversationId: string): Promise<void> =>
  apply(wb().deleteConversation(conversationId));
export const updateWorkbenchSettings = (request: WorkbenchSettingsUpdateRequest): Promise<void> =>
  apply(wb().updateSettings(request));

/** The worker's recent terminal text (already stripped of control characters by main). */
export async function readTaskOutput(taskId: string): Promise<string> {
  return (await wb().taskOutput(taskId)).text;
}
