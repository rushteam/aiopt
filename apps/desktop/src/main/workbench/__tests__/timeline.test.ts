import { describe, expect, it } from 'vitest';
import { createTimeline, parseTimeline, type TimelineTask } from '../timeline';
import { WORKBENCH_LIMITS, type TaskStatus, type TaskTimelineEvent } from '../../../shared/workbench';

const CONV = '019a0000-0000-7000-8000-000000000001';

function task(id: string, status: TaskStatus, title = `task ${id}`): TimelineTask {
  return { id, title, status, conversationId: CONV };
}

const taskEvents = (events: ReturnType<ReturnType<typeof createTimeline>['events']>): TaskTimelineEvent[] =>
  events.filter((e): e is TaskTimelineEvent => e.kind === 'task');

describe('workbench timeline: tasks', () => {
  it('records each status change once, with the run length from its start', () => {
    let now = 1_000;
    const tl = createTimeline([], [], () => now);
    expect(tl.observe([task('a1', 'proposed')])).toBe(true);
    expect(tl.observe([task('a1', 'proposed')])).toBe(false);
    now = 2_000;
    tl.observe([task('a1', 'starting')]);
    now = 5_000;
    tl.observe([task('a1', 'working')]);
    now = 65_000;
    tl.observe([task('a1', 'review')]);
    now = 70_000;
    tl.observe([task('a1', 'done')]);
    expect(taskEvents(tl.events()).map((e) => [e.from, e.status, e.at, e.runMs])).toEqual([
      [null, 'proposed', 1_000, null],
      ['proposed', 'starting', 2_000, null],
      ['starting', 'working', 5_000, 3_000],
      ['working', 'review', 65_000, 63_000],
      ['review', 'done', 70_000, 68_000],
    ]);
    expect(tl.events().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(tl.revision()).toBe(5);
    // After the run ended, a later step carries no run length.
    tl.observe([task('a1', 'proposed')]);
    expect(taskEvents(tl.events()).at(-1)?.runMs).toBeNull();
  });

  it('adds nothing for the board as loaded, and forgets removed tasks', () => {
    let now = 0;
    const tl = createTimeline([], [task('a1', 'done')], () => now);
    expect(tl.observe([task('a1', 'done')])).toBe(false);
    now = 10;
    expect(tl.observe([])).toBe(false);
    // Back with the same id: a new task, so `from` is null.
    tl.observe([task('a1', 'proposed')]);
    expect(tl.events()).toEqual([
      {
        kind: 'task',
        seq: 1,
        at: 10,
        taskId: 'a1',
        title: 'task a1',
        conversationId: CONV,
        from: null,
        status: 'proposed',
        runMs: null,
      },
    ]);
  });

  it('keeps the newest events and round-trips through its file', () => {
    let now = 0;
    const tl = createTimeline([], [], () => now);
    for (let i = 0; i < WORKBENCH_LIMITS.timelineEvents + 5; i += 1) {
      now = i;
      tl.observe([task('a1', i % 2 === 0 ? 'proposed' : 'stopped')]);
    }
    tl.turnStarted('user');
    tl.turnEnded('done', CONV);
    const events = tl.events();
    expect(events).toHaveLength(WORKBENCH_LIMITS.timelineEvents);
    expect(events[0]?.seq).toBe(7);
    const reloaded = createTimeline(parseTimeline(tl.toJson()), [], () => now);
    expect(reloaded.events()).toEqual(events);
    // Seq keeps increasing after a reload.
    reloaded.observe([task('b2', 'proposed')]);
    expect(reloaded.events().at(-1)?.seq).toBe(WORKBENCH_LIMITS.timelineEvents + 7);
  });

  it('drops persisted events that do not fit', () => {
    const good = {
      kind: 'task',
      seq: 1,
      at: 5,
      taskId: 'a1',
      title: 'ok\u0007',
      conversationId: CONV,
      from: null,
      status: 'done',
      runMs: 3,
    };
    const turn = { kind: 'turn', seq: 10, at: 9, conversationId: CONV, trigger: 'user', outcome: 'done', durationMs: 4 };
    const text = JSON.stringify({
      version: 1,
      events: [
        good,
        { ...good, seq: 2, taskId: '../x' },
        { ...good, seq: 3, status: 'exploded' },
        { ...good, seq: 4, from: 'nope' },
        { ...good, seq: 0 },
        { ...good, seq: 5, at: 'soon' },
        { ...good, seq: 6, conversationId: '../etc', runMs: -1 },
        { ...good, seq: 7, kind: 'other' },
        turn,
        { ...turn, seq: 11, trigger: 'robot' },
        { ...turn, seq: 12, outcome: 'meh' },
        { ...turn, seq: 13, durationMs: -5 },
        { ...turn, seq: 14, conversationId: 42 },
        null,
      ],
    });
    const out = parseTimeline(text);
    expect(out.map((e) => e.seq)).toEqual([1, 6, 10, 14]);
    expect(out[0]).toMatchObject({ kind: 'task' });
    expect((out[0] as TaskTimelineEvent).title).not.toContain('\u0007');
    expect(out[1]).toMatchObject({ conversationId: null, runMs: null });
    expect(out[2]).toEqual(turn);
    expect(out[3]).toMatchObject({ kind: 'turn', conversationId: null });
    expect(parseTimeline('not json')).toEqual([]);
    expect(parseTimeline(null)).toEqual([]);
  });

  it('reads a task event written before turns had a kind', () => {
    const legacy = { seq: 1, at: 5, taskId: 'a1', title: 't', conversationId: null, from: null, status: 'done', runMs: null };
    expect(parseTimeline(JSON.stringify({ version: 1, events: [legacy] }))).toEqual([{ kind: 'task', ...legacy }]);
  });
});

describe('workbench timeline: coordinator turns', () => {
  it('records a turn when it ends, with what set it off and how long it took', () => {
    let now = 1_000;
    const tl = createTimeline([], [], () => now);
    expect(tl.turnEnded('done', CONV)).toBe(false);
    tl.turnStarted('taskUpdate');
    expect(tl.inTurn()).toBe(true);
    // A second start (pi's retry) keeps the open turn.
    now = 1_500;
    tl.turnStarted('taskUpdate');
    tl.turnTrigger('user');
    now = 9_000;
    expect(tl.turnEnded('error', CONV)).toBe(true);
    expect(tl.inTurn()).toBe(false);
    expect(tl.events()).toEqual([
      { kind: 'turn', seq: 1, at: 9_000, conversationId: CONV, trigger: 'user', outcome: 'error', durationMs: 8_000 },
    ]);
    expect(tl.revision()).toBe(1);
    // The trigger can't change once the turn is closed.
    tl.turnTrigger('taskUpdate');
    expect(tl.events()).toHaveLength(1);
  });
});
