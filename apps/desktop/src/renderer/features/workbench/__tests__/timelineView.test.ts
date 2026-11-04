import { describe, expect, it } from 'vitest';
import type { TaskTimelineEvent, TurnTimelineEvent } from '../../../../shared/workbench';
import { formatDuration, groupTimelineByDay, matchesTimelineFilter, timelineEventKind } from '../timelineView';

function ev(
  seq: number,
  at: number,
  from: TaskTimelineEvent['from'],
  status: TaskTimelineEvent['status'],
): TaskTimelineEvent {
  return { kind: 'task', seq, at, taskId: 'a1', title: 't', conversationId: null, from, status, runMs: null };
}

function turn(seq: number, at: number): TurnTimelineEvent {
  return { kind: 'turn', seq, at, conversationId: null, trigger: 'user', outcome: 'done', durationMs: 1_000 };
}

describe('timeline view helpers', () => {
  it('names what a status change means', () => {
    expect(timelineEventKind({ from: null, status: 'proposed' })).toBe('created');
    expect(timelineEventKind({ from: 'proposed', status: 'starting' })).toBe('started');
    expect(timelineEventKind({ from: 'starting', status: 'working' })).toBe('running');
    expect(timelineEventKind({ from: 'review', status: 'working' })).toBe('resumed');
    expect(timelineEventKind({ from: 'working', status: 'done' })).toBe('done');
    expect(timelineEventKind({ from: 'stopped', status: 'proposed' })).toBe('requeued');
  });

  it('filters key moments, tasks only, or coordinator turns only', () => {
    const running = ev(1, 0, 'starting', 'working');
    const failed = ev(2, 0, 'working', 'failed');
    const t = turn(3, 0);
    expect([running, failed, t].filter((e) => matchesTimelineFilter(e, 'key'))).toEqual([failed, t]);
    expect([running, failed, t].filter((e) => matchesTimelineFilter(e, 'all'))).toHaveLength(3);
    expect([running, failed, t].filter((e) => matchesTimelineFilter(e, 'tasks'))).toEqual([running, failed]);
    expect([running, failed, t].filter((e) => matchesTimelineFilter(e, 'turns'))).toEqual([t]);
  });

  it('formats durations in the locale units', () => {
    expect(formatDuration(45_000, 'en')).toBe('45 sec');
    expect(formatDuration(200_000, 'en')).toBe('3 min 20 sec');
    expect(formatDuration(3_900_000, 'en')).toBe('1 hr 5 min');
    expect(formatDuration(0, 'en')).toBe('0 sec');
  });

  it('groups newest first by local day', () => {
    const d1 = new Date(2025, 0, 1, 9, 0).getTime();
    const d2 = new Date(2025, 0, 2, 18, 30).getTime();
    const days = groupTimelineByDay([ev(1, d1, null, 'proposed'), ev(2, d2, 'proposed', 'starting'), turn(3, d2)]);
    expect(days.map((d) => d.key)).toEqual(['2025-01-02', '2025-01-01']);
    expect(days[0]!.events.map((e) => e.seq)).toEqual([3, 2]);
  });
});
