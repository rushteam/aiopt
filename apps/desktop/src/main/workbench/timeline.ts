// The Workbench timeline: one event per task status change (created, started, finished its turn,
// done, stopped, failed…) with how long the run had taken, and one per coordinator turn (who set
// it off, how it ended, how long it took).
//
// Task events: the manager hands every board state to `observe` (from its `changed()`), so each
// transition is caught in one place whatever caused it (a launch, the poll, complete / stop, the
// app stopping). Turn events: the manager calls `turnStarted` / `turnEnded` from the
// coordinator's event stream.
//
// Events are kept newest last, capped, and persisted to `timeline.json` as display data only:
// ids, titles, statuses and times, never prompts, messages or worker output.

import {
  isLiveTaskStatus,
  isTaskStatus,
  isValidConversationId,
  isValidWorkbenchId,
  sanitizeWorkbenchText,
  WORKBENCH_LIMITS,
  type TaskStatus,
  type TimelineEvent,
  type TurnOutcome,
  type TurnTrigger,
} from '../../shared/workbench';

/** What the timeline reads of a task. */
export interface TimelineTask {
  id: string;
  title: string;
  status: TaskStatus;
  conversationId: string | null;
}

export interface Timeline {
  /** Record the task status changes since the last call; true when an event was added. */
  observe(tasks: Iterable<TimelineTask>): boolean;
  /** A coordinator turn began (its first `agent_start`). A turn already open is kept. */
  turnStarted(trigger: TurnTrigger): void;
  /** Change what set the open turn off (pi names the turn's first message after it starts). */
  turnTrigger(trigger: TurnTrigger): void;
  /** Whether a turn is open. */
  inTurn(): boolean;
  /** Close the open turn; true when an event was added (false when none was open). */
  turnEnded(outcome: TurnOutcome, conversationId: string | null): boolean;
  events(): TimelineEvent[];
  /** Bumps on every new event (the snapshot carries it so the renderer knows to refetch). */
  revision(): number;
  /** The persisted form. */
  toJson(): string;
}

interface TimelineDoc {
  version: 1;
  events: TimelineEvent[];
}

const TURN_TRIGGERS: readonly TurnTrigger[] = ['user', 'taskUpdate'];
const TURN_OUTCOMES: readonly TurnOutcome[] = ['done', 'error', 'aborted', 'interrupted'];

function isDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** One persisted record, or null when it does not fit. */
function parseEvent(raw: unknown): TimelineEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.seq !== 'number' || !Number.isSafeInteger(r.seq) || r.seq < 1) return null;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  const conversationId = isValidConversationId(r.conversationId) ? r.conversationId : null;
  if (r.kind === 'turn') {
    if (!TURN_TRIGGERS.includes(r.trigger as TurnTrigger)) return null;
    if (!TURN_OUTCOMES.includes(r.outcome as TurnOutcome) || !isDuration(r.durationMs)) return null;
    return {
      kind: 'turn',
      seq: r.seq,
      at: r.at,
      conversationId,
      trigger: r.trigger as TurnTrigger,
      outcome: r.outcome as TurnOutcome,
      durationMs: r.durationMs,
    };
  }
  // A record without a kind is a task event.
  if (r.kind !== undefined && r.kind !== 'task') return null;
  if (!isValidWorkbenchId(r.taskId) || typeof r.title !== 'string' || !isTaskStatus(r.status)) return null;
  const from = r.from === null || r.from === undefined ? null : isTaskStatus(r.from) ? r.from : undefined;
  if (from === undefined) return null;
  return {
    kind: 'task',
    seq: r.seq,
    at: r.at,
    taskId: r.taskId,
    title: sanitizeWorkbenchText(r.title).slice(0, WORKBENCH_LIMITS.taskTitle),
    conversationId,
    from,
    status: r.status,
    runMs: isDuration(r.runMs) ? r.runMs : null,
  };
}

/** Parse a persisted timeline, dropping anything that does not fit. */
export function parseTimeline(text: string | null): TimelineEvent[] {
  if (!text) return [];
  try {
    const doc = JSON.parse(text) as Partial<TimelineDoc>;
    if (!Array.isArray(doc.events)) return [];
    const out: TimelineEvent[] = [];
    for (const raw of doc.events as unknown[]) {
      const event = parseEvent(raw);
      if (event) out.push(event);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out.slice(-WORKBENCH_LIMITS.timelineEvents);
  } catch {
    return [];
  }
}

/**
 * `initial` is the board as loaded (no events for it: a status the app restored is not a
 * change). Run starts and the open turn live only in memory: neither outlives the app.
 */
export function createTimeline(
  loaded: readonly TimelineEvent[],
  initial: Iterable<TimelineTask>,
  now: () => number,
): Timeline {
  const list: TimelineEvent[] = [...loaded];
  let seq = list.reduce((max, e) => Math.max(max, e.seq), 0);
  let rev = 0;
  const lastStatus = new Map<string, TaskStatus>();
  for (const t of initial) lastStatus.set(t.id, t.status);
  /** When each task's current run started (its move to `starting`). */
  const runStarts = new Map<string, number>();
  let turn: { startedAt: number; trigger: TurnTrigger } | null = null;

  function append(event: TimelineEvent): void {
    list.push(event);
    if (list.length > WORKBENCH_LIMITS.timelineEvents) list.splice(0, list.length - WORKBENCH_LIMITS.timelineEvents);
  }

  function pushTask(t: TimelineTask, from: TaskStatus | null, at: number): void {
    const start = runStarts.get(t.id);
    // A run's length is shown on every step after it began, up to the step that ends it.
    const runMs = start !== undefined && t.status !== 'starting' ? Math.max(0, at - start) : null;
    seq += 1;
    append({
      kind: 'task',
      seq,
      at,
      taskId: t.id,
      title: t.title,
      conversationId: t.conversationId,
      from,
      status: t.status,
      runMs,
    });
  }

  return {
    observe(tasks) {
      const at = now();
      let added = false;
      const seen = new Set<string>();
      for (const t of tasks) {
        seen.add(t.id);
        const before = lastStatus.get(t.id);
        if (before === t.status) continue;
        lastStatus.set(t.id, t.status);
        if (t.status === 'starting') runStarts.set(t.id, at);
        pushTask(t, before ?? null, at);
        if (!isLiveTaskStatus(t.status)) runStarts.delete(t.id);
        added = true;
      }
      // Removed tasks: forget them (their past events stay).
      for (const id of [...lastStatus.keys()]) {
        if (!seen.has(id)) {
          lastStatus.delete(id);
          runStarts.delete(id);
        }
      }
      if (added) rev += 1;
      return added;
    },
    turnStarted(trigger) {
      if (!turn) turn = { startedAt: now(), trigger };
    },
    turnTrigger(trigger) {
      if (turn) turn.trigger = trigger;
    },
    inTurn: () => turn !== null,
    turnEnded(outcome, conversationId) {
      if (!turn) return false;
      const at = now();
      seq += 1;
      append({
        kind: 'turn',
        seq,
        at,
        conversationId,
        trigger: turn.trigger,
        outcome,
        durationMs: Math.max(0, at - turn.startedAt),
      });
      turn = null;
      rev += 1;
      return true;
    },
    events: () => list.map((e) => ({ ...e })),
    revision: () => rev,
    toJson: () => `${JSON.stringify({ version: 1, events: list } satisfies TimelineDoc, null, 2)}\n`,
  };
}
