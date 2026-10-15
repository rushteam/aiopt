import { describe, expect, it } from 'vitest';
import { MENTION_SESSIONS_MAX, mentionOptions, moveHighlight } from '../mentionSuggest';
import type { SessionSummary } from '../../../../shared/agentSessions';
import type { TaskView } from '../../../../shared/workbench';

const session = (n: number, title: string): SessionSummary => ({
  agentId: 'pi',
  sessionId: `abcdefgh-${String(n).padStart(4, '0')}`,
  title,
  cwd: '/w/app',
  startedAt: 0,
  updatedAt: 0,
  model: '',
  gitBranch: '',
  messageCount: 1,
});

describe('mention options', () => {
  it('lists matching tasks, then sessions found by the shared search', () => {
    const tasks = [
      { id: 'tsk_1', title: 'Retry fetch', status: 'running' },
      { id: 'tsk_2', title: 'Docs', status: 'done' },
    ] as unknown as TaskView[];
    const opts = mentionOptions('retry', tasks, [session(1, 'retry logic'), session(2, 'other')], 'Untitled');
    expect(opts.map((o) => [o.kind, o.label])).toEqual([
      ['task', 'Retry fetch'],
      ['session', 'retry logic'],
    ]);
    expect(opts[0]!.token).toBe('@task:tsk_1');
    expect(opts[1]!.token).toBe('@session:pi:abcdefgh-0001');
  });

  it('caps sessions and labels untitled ones', () => {
    const many = Array.from({ length: 20 }, (_, i) => session(i, ''));
    const opts = mentionOptions('', [], many, 'Untitled');
    expect(opts).toHaveLength(MENTION_SESSIONS_MAX);
    expect(opts[0]!.label).toBe('Untitled');
  });

  it('wraps the highlight', () => {
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(0, 1, 0)).toBe(-1);
  });
});
