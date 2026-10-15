// What the coordinator composer offers after an `@`: board tasks and agent sessions, both
// found by the typed words. Sessions use the Sessions screen's search (sessionSearch.ts), so a
// session turns up here exactly when it would there. Pure; no DOM.

import type { SessionSummary } from '../../../shared/agentSessions';
import { sessionMentionToken } from '../../../shared/sessionMention';
import { taskMentionToken } from '../../../shared/taskMention';
import type { TaskView } from '../../../shared/workbench';
import { agentName, searchSessions, shortDir } from '../sessions/sessionSearch';

export interface MentionOption {
  key: string;
  kind: 'task' | 'session';
  /** Inserted into the draft. */
  token: string;
  label: string;
  detail: string;
}

export const MENTION_TASKS_MAX = 4;
export const MENTION_SESSIONS_MAX = 8;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function taskMatches(task: TaskView, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const title = task.title.toLowerCase();
  return words.every((w) => title.includes(w) || task.id.startsWith(w));
}

export function mentionOptions(
  query: string,
  tasks: readonly TaskView[],
  sessions: readonly SessionSummary[],
  untitled: string,
): MentionOption[] {
  const out: MentionOption[] = [];
  let n = 0;
  for (const task of tasks) {
    if (n >= MENTION_TASKS_MAX) break;
    if (!taskMatches(task, query)) continue;
    out.push({ key: `task:${task.id}`, kind: 'task', token: taskMentionToken(task.id), label: task.title, detail: task.status });
    n += 1;
  }
  for (const s of searchSessions(sessions, query, MENTION_SESSIONS_MAX)) {
    out.push({
      key: `session:${s.agentId}:${s.sessionId}`,
      kind: 'session',
      token: sessionMentionToken(s),
      label: s.title || untitled,
      detail: [agentName(s.agentId), shortDir(s.cwd), s.updatedAt > 0 ? dateFormat.format(s.updatedAt) : '']
        .filter(Boolean)
        .join(' · '),
    });
  }
  return out;
}

/** Move the highlighted option by `delta`, wrapping; -1 when there is nothing to pick. */
export function moveHighlight(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}
