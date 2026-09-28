// Task status transitions driven by herdr's view of each worker.
//
// herdr reports an agent's state as idle / working / blocked / done / unknown (the pi
// integration extension pushes it over herdr's socket). A task's own status adds what herdr
// can't know — that the user approved it, or accepted the result — so this module maps one onto
// the other. Pure: the manager polls `herdr agent list` and feeds each row through here.

import type { TaskStatus } from '../../shared/workbench';

export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

const HERDR_STATUSES: readonly HerdrAgentStatus[] = ['idle', 'working', 'blocked', 'done', 'unknown'];

export function toHerdrAgentStatus(value: unknown): HerdrAgentStatus {
  return typeof value === 'string' && (HERDR_STATUSES as readonly string[]).includes(value)
    ? (value as HerdrAgentStatus)
    : 'unknown';
}

/**
 * After a prompt is sent, pi may still read as idle for a moment before it picks the message
 * up. Within this window an idle/done reading is taken as "not started yet", not "finished".
 */
export const PROMPT_GRACE_MS = 5000;

/**
 * The next status for a live task given herdr's reading of its worker. Terminal and proposed
 * tasks never change here (only a user action moves them).
 */
export function nextTaskStatus(
  current: TaskStatus,
  agent: HerdrAgentStatus,
  msSincePrompt: number,
): TaskStatus {
  if (current !== 'starting' && current !== 'working' && current !== 'blocked' && current !== 'review') {
    return current;
  }
  switch (agent) {
    case 'working':
      return 'working';
    case 'blocked':
      return 'blocked';
    case 'idle':
    case 'done':
      if (current === 'starting') return 'starting';
      if (msSincePrompt < PROMPT_GRACE_MS) return current;
      return 'review';
    default:
      return current;
  }
}

// The per-status action table lives in shared so the renderer shows the same buttons main allows.
export { TASK_ACTIONS, taskAllows, type TaskAction } from '../../shared/workbench';
