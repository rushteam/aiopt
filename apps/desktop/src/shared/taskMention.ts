// Coordinator chat may reference board tasks as @task:<id> (opaque id from main).

import type { TaskStatus } from './workbench';
import { isValidWorkbenchId } from './workbench';

export const TASK_MENTION_DRAG_TYPE = 'application/x-aiopt-workbench-task';

/** Wire token inserted into the coordinator composer. */
export function taskMentionToken(taskId: string): string {
  return `@task:${taskId}`;
}

export const TASK_MENTION_RE = /@task:([a-z0-9]{1,32})\b/g;

export interface TaskMentionDragPayload {
  id: string;
  title: string;
}

export function parseTaskMentionDrag(data: string): TaskMentionDragPayload | null {
  try {
    const doc = JSON.parse(data) as unknown;
    if (!doc || typeof doc !== 'object') return null;
    const id = (doc as { id?: unknown }).id;
    const title = (doc as { title?: unknown }).title;
    if (!isValidWorkbenchId(id) || typeof title !== 'string' || title.trim() === '') return null;
    return { id, title: title.trim() };
  } catch {
    return null;
  }
}

/** Expand @task:id tokens before the orchestrator prompt (user text stays stored as typed). */
export function expandTaskMentions(
  text: string,
  tasks: readonly { id: string; title: string; status: TaskStatus }[],
): string {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return text.replace(TASK_MENTION_RE, (full, id: string) => {
    const task = byId.get(id);
    if (!task) return full;
    const title = task.title.replace(/\s+/g, ' ').trim();
    return `@${title} (task id ${id}, status ${task.status})`;
  });
}
