import { describe, expect, it } from 'vitest';
import { nextTaskStatus, PROMPT_GRACE_MS, taskAllows, toHerdrAgentStatus } from '../taskModel';
import { TASK_STATUSES } from '../../../shared/workbench';

const LATE = PROMPT_GRACE_MS + 1;

describe('nextTaskStatus', () => {
  it('follows working / blocked from any live status', () => {
    for (const s of ['starting', 'working', 'blocked', 'review'] as const) {
      expect(nextTaskStatus(s, 'working', LATE)).toBe('working');
      expect(nextTaskStatus(s, 'blocked', LATE)).toBe('blocked');
    }
  });

  it('moves a finished worker to review, but not inside the prompt grace window', () => {
    expect(nextTaskStatus('working', 'done', LATE)).toBe('review');
    expect(nextTaskStatus('working', 'idle', LATE)).toBe('review');
    expect(nextTaskStatus('working', 'idle', 100)).toBe('working');
  });

  it('keeps a starting task starting until the worker actually picks the prompt up', () => {
    expect(nextTaskStatus('starting', 'idle', LATE)).toBe('starting');
    expect(nextTaskStatus('starting', 'unknown', LATE)).toBe('starting');
  });

  it('never moves proposed or terminal tasks', () => {
    for (const s of ['proposed', 'done', 'stopped', 'failed'] as const) {
      expect(nextTaskStatus(s, 'working', LATE)).toBe(s);
    }
  });
});

describe('toHerdrAgentStatus', () => {
  it('maps unknown values to unknown', () => {
    expect(toHerdrAgentStatus('working')).toBe('working');
    expect(toHerdrAgentStatus('exploded')).toBe('unknown');
    expect(toHerdrAgentStatus(3)).toBe('unknown');
  });
});

describe('taskAllows', () => {
  it('only lets a task that is not running be edited and only a live task be messaged', () => {
    expect(TASK_STATUSES.filter((s) => taskAllows('edit', s))).toEqual(['proposed', 'stopped', 'failed']);
    expect(TASK_STATUSES.filter((s) => taskAllows('message', s))).toEqual(['working', 'blocked', 'review']);
    expect(taskAllows('remove', 'working')).toBe(false);
  });
});
