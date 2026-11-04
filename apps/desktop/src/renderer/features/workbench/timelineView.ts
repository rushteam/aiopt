// Pure helpers for the Workbench timeline view: what each event says, how long a run or turn
// took, which events a filter shows, and the events grouped by local day (newest first).

import type { TaskTimelineEvent, TimelineEvent } from '../../../shared/workbench';

/** What a task status change means to the user; one i18n key `workbench.timeline.event.<kind>` each. */
export type TimelineEventKind =
  | 'created'
  | 'started'
  | 'running'
  | 'resumed'
  | 'blocked'
  | 'review'
  | 'done'
  | 'stopped'
  | 'failed'
  | 'requeued';

export function timelineEventKind(e: Pick<TaskTimelineEvent, 'from' | 'status'>): TimelineEventKind {
  if (e.from === null) return 'created';
  switch (e.status) {
    case 'starting':
      return 'started';
    case 'working':
      return e.from === 'starting' ? 'running' : 'resumed';
    case 'proposed':
      return 'requeued';
    default:
      return e.status;
  }
}

/** Whether a kind ends a run (shown with the run's total length). */
export function endsRun(kind: TimelineEventKind): boolean {
  return kind === 'done' || kind === 'stopped' || kind === 'failed';
}

/**
 * A duration in the locale's own units: "1 hr 5 min", "3 min 20 sec", "45 sec". Uses
 * `Intl.NumberFormat` unit styles, so it needs no i18n entry.
 */
export function formatDuration(ms: number, locale: string): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const unit = (value: number, u: 'hour' | 'minute' | 'second'): string =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'short' }).format(value);
  const parts: string[] = [];
  if (h > 0) parts.push(unit(h, 'hour'));
  if (m > 0) parts.push(unit(m, 'minute'));
  // Seconds only matter for short runs.
  if (h === 0 && (s > 0 || parts.length === 0)) parts.push(unit(s, 'second'));
  return parts.join(' ');
}

/** The local calendar day of a time, as a sortable key. */
export function localDayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface TimelineDay {
  key: string;
  /** Any time in that day (for formatting the header). */
  at: number;
  events: TimelineEvent[];
}

/** Events newest first, grouped by local day. */
export function groupTimelineByDay(events: readonly TimelineEvent[]): TimelineDay[] {
  const sorted = [...events].sort((a, b) => b.at - a.at || b.seq - a.seq);
  const days: TimelineDay[] = [];
  for (const e of sorted) {
    const key = localDayKey(e.at);
    const last = days.at(-1);
    if (last && last.key === key) last.events.push(e);
    else days.push({ key, at: e.at, events: [e] });
  }
  return days;
}

/**
 * What the timeline shows: key moments (runs starting, waiting for review or ending, and every
 * coordinator turn), everything, only task changes, or only coordinator turns.
 */
export type TimelineFilter = 'key' | 'all' | 'tasks' | 'turns';

export const TIMELINE_FILTERS: readonly TimelineFilter[] = ['key', 'all', 'tasks', 'turns'];

export function matchesTimelineFilter(e: TimelineEvent, filter: TimelineFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'tasks':
      return e.kind === 'task';
    case 'turns':
      return e.kind === 'turn';
    case 'key': {
      if (e.kind === 'turn') return true;
      const kind = timelineEventKind(e);
      return kind === 'started' || endsRun(kind) || kind === 'review';
    }
  }
}
