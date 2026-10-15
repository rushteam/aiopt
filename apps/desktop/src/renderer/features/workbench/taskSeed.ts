// A new-task draft handed to the workbench from elsewhere (the Sessions screen's "New
// workbench task"). The prompt carries an @session reference, not the session text: main
// attaches the excerpt when the worker starts, so the board keeps a short prompt.

import type { SessionSummary } from '../../../shared/agentSessions';
import { sessionMentionToken } from '../../../shared/sessionMention';
import { WORKBENCH_LIMITS } from '../../../shared/workbench';

export interface TaskSeed {
  title: string;
  prompt: string;
}

/** A draft that points a worker at `session`; the user writes the actual ask after it. */
export function taskSeedFromSession(session: Pick<SessionSummary, 'agentId' | 'sessionId' | 'title'>, untitled: string): TaskSeed {
  const title = (session.title.replace(/\s+/g, ' ').trim() || untitled).slice(0, WORKBENCH_LIMITS.taskTitle);
  return { title, prompt: `${sessionMentionToken(session)}\n\n` };
}
