import { describe, expect, it } from 'vitest';
import {
  COMPLETE_TASKS_TOOL,
  createTranscript,
  extractLaunchTaskIds,
  extractProposedTasks,
  LAUNCH_TASKS_TOOL,
  PROPOSE_TASKS_TOOL,
  TASK_UPDATE_MESSAGE,
} from '../piEvents';
import { WORKBENCH_LIMITS } from '../../../shared/workbench';
import { attachSessionContext } from '../../../shared/sessionMention';

/** The event sequence pi emitted for one propose_tasks round-trip (captured from a live run). */
function proposalRun() {
  return [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'plan it' }] } },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'plan it' }] } },
    { type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Plan' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ning. ' } },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Planning. ' },
          { type: 'toolCall', id: 'call_1', name: PROPOSE_TASKS_TOOL, arguments: {} },
        ],
        stopReason: 'toolUse',
      },
    },
    {
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: PROPOSE_TASKS_TOOL,
      args: { tasks: [{ title: 'A', prompt: 'do a' }] },
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: PROPOSE_TASKS_TOOL,
      result: {
        content: [{ type: 'text', text: 'ok 1' }],
        details: { tasks: [{ title: 'A', prompt: 'do a' }] },
      },
      isError: false,
    },
    { type: 'turn_end' },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Proposed.' }], stopReason: 'stop' } },
    { type: 'agent_end', messages: [] },
    { type: 'agent_settled' },
  ];
}

describe('transcript reducer', () => {
  it('folds a full proposal run into user / assistant / tool items and extracts the tasks', () => {
    const tr = createTranscript();
    const proposed = proposalRun().flatMap((e) => tr.apply(e).proposed);
    expect(proposed).toEqual([{ title: 'A', prompt: 'do a', folder: null, dependsOnTitles: [], dependsOnIds: [] }]);
    const items = tr.items();
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'plan it' });
    expect(items[1]).toMatchObject({ kind: 'assistant', text: 'Planning. ', streaming: false });
    expect(items[2]).toMatchObject({ kind: 'tool', name: PROPOSE_TASKS_TOOL, result: 'ok 1', done: true });
    expect(items[3]).toMatchObject({ kind: 'assistant', text: 'Proposed.' });
    expect(tr.streaming()).toBe(false);
  });

  it('shows only what the user typed, not the session context main attached', () => {
    const typed = 'see @session:pi:abcdefgh1234';
    const sent = attachSessionContext(typed, ['<<<SESSION\nsecret-ish excerpt\nSESSION>>>'], []);
    const live = createTranscript();
    live.apply({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: sent }] } });
    expect(live.items()).toEqual([expect.objectContaining({ kind: 'user', text: typed })]);
    const loaded = createTranscript();
    loaded.load([{ role: 'user', content: [{ type: 'text', text: sent }] }]);
    expect(loaded.items()).toEqual([expect.objectContaining({ kind: 'user', text: typed })]);
  });

  it('tracks streaming between agent_start and agent_settled, honoring willRetry', () => {
    const tr = createTranscript();
    tr.apply({ type: 'agent_start' });
    expect(tr.streaming()).toBe(true);
    tr.apply({ type: 'agent_end', willRetry: true });
    expect(tr.streaming()).toBe(true);
    tr.apply({ type: 'agent_settled' });
    expect(tr.streaming()).toBe(false);
  });

  it('streams text and thinking deltas into the open assistant item', () => {
    const tr = createTranscript();
    tr.apply({ type: 'message_start', message: { role: 'assistant' } });
    tr.apply({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } });
    tr.apply({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } });
    expect(tr.items()[0]).toMatchObject({ text: 'Hi', thinking: 'hmm', streaming: true });
  });

  it('drops an empty tool-only assistant bubble and records an error stop', () => {
    const tr = createTranscript();
    tr.apply({ type: 'message_start', message: { role: 'assistant' } });
    tr.apply({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '401 bad key' } });
    expect(tr.items()).toEqual([expect.objectContaining({ kind: 'error', message: '401 bad key' })]);
  });

  it('does not extract tasks from a failed or unrelated tool', () => {
    const tr = createTranscript();
    const details = { tasks: [{ title: 'A', prompt: 'x' }] };
    expect(tr.apply({ type: 'tool_execution_end', toolCallId: 't', toolName: PROPOSE_TASKS_TOOL, result: { details }, isError: true }).proposed).toEqual([]);
    expect(tr.apply({ type: 'tool_execution_end', toolCallId: 't', toolName: 'read', result: { details }, isError: false }).launchTaskIds).toEqual([]);
  });

  it('extracts launch ids from launch_tasks', () => {
    const tr = createTranscript();
    tr.apply({ type: 'tool_execution_start', toolCallId: 'l1', toolName: LAUNCH_TASKS_TOOL, args: {} });
    expect(
      tr.apply({
        type: 'tool_execution_end',
        toolCallId: 'l1',
        toolName: LAUNCH_TASKS_TOOL,
        result: { details: { task_ids: ['abc123', '../etc', ''] } },
        isError: false,
      }).launchTaskIds,
    ).toEqual(['abc123']);
  });

  it('ignores malformed events instead of throwing', () => {
    const tr = createTranscript();
    for (const e of [{}, { type: 'message_start' }, { type: 'message_update', assistantMessageEvent: 5 }, { type: 'tool_execution_start', toolCallId: 3 }]) {
      expect(() => tr.apply(e)).not.toThrow();
    }
    expect(tr.items()).toEqual([]);
  });

  it('caps the transcript length', () => {
    const tr = createTranscript();
    for (let i = 0; i < WORKBENCH_LIMITS.chatItems + 5; i += 1) tr.pushError(`e${i}`);
    const items = tr.items();
    expect(items).toHaveLength(WORKBENCH_LIMITS.chatItems);
    expect(items.at(-1)).toMatchObject({ message: `e${WORKBENCH_LIMITS.chatItems + 4}` });
  });

  it('windows the newest items and pages older ones by id', () => {
    const tr = createTranscript();
    for (let i = 0; i < 100; i += 1) tr.pushError(`e${i}`);
    const w = tr.window(40);
    expect(w.items).toHaveLength(40);
    expect(w.hasMore).toBe(true);
    expect(w.items[0]).toMatchObject({ message: 'e60' });

    const p1 = tr.page(w.items[0]!.id, 40);
    expect(p1.items.map((i) => (i as { message: string }).message)).toEqual(
      Array.from({ length: 40 }, (_, i) => `e${20 + i}`),
    );
    expect(p1.hasMore).toBe(true);
    const p2 = tr.page(p1.items[0]!.id, 40);
    expect(p2.items).toHaveLength(20);
    expect(p2.hasMore).toBe(false);
    expect(tr.page(p2.items[0]!.id, 40)).toEqual({ items: [], hasMore: false });
    expect(tr.page('nope', 40)).toEqual({ items: [], hasMore: false });
  });

  it('widens the window back to a reply that is still streaming', () => {
    const tr = createTranscript();
    tr.apply({ type: 'agent_start' });
    tr.apply({ type: 'message_start', message: { role: 'assistant' } });
    for (let i = 0; i < 10; i += 1) tr.pushError(`e${i}`);
    const w = tr.window(3);
    expect(w.items).toHaveLength(11);
    expect(w.items[0]).toMatchObject({ kind: 'assistant', streaming: true });
    expect(w.hasMore).toBe(false);
  });

  it('bumps the epoch when the transcript is replaced', () => {
    const tr = createTranscript();
    const e0 = tr.epoch();
    tr.pushError('x');
    expect(tr.epoch()).toBe(e0);
    tr.clear();
    expect(tr.epoch()).toBe(e0 + 1);
    tr.load([]);
    expect(tr.epoch()).toBe(e0 + 2);
  });

  it('returns copies, so callers cannot mutate the live transcript', () => {
    const tr = createTranscript();
    tr.pushError('x');
    (tr.items()[0] as { message: string }).message = 'mutated';
    expect(tr.items()[0]).toMatchObject({ message: 'x' });
    tr.pushProposal(['aa']);
    (tr.items()[1] as { taskIds: string[] }).taskIds.push('bb');
    expect(tr.items()[1]).toMatchObject({ taskIds: ['aa'] });
  });

  it('puts a card proposed mid-turn below the reply that follows it', () => {
    const tr = createTranscript();
    tr.apply({ type: 'agent_start' });
    tr.apply({ type: 'tool_execution_start', toolCallId: 'p1', toolName: PROPOSE_TASKS_TOOL, args: {} });
    tr.apply({ type: 'tool_execution_end', toolCallId: 'p1', toolName: PROPOSE_TASKS_TOOL, result: {}, isError: false });
    tr.pushProposal(['aa']);
    expect(tr.items().some((i) => i.kind === 'proposal')).toBe(false);
    tr.apply({ type: 'message_start', message: { role: 'assistant' } });
    tr.apply({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Approve it below.' }] } });
    // A retry keeps the turn open; the card still waits.
    tr.apply({ type: 'agent_end', willRetry: true });
    expect(tr.items().some((i) => i.kind === 'proposal')).toBe(false);
    tr.apply({ type: 'agent_end' });
    expect(tr.items().map((i) => i.kind)).toEqual(['tool', 'assistant', 'proposal']);
  });

  it('drops a held card when the conversation is cleared', () => {
    const tr = createTranscript();
    tr.apply({ type: 'agent_start' });
    tr.pushProposal(['aa']);
    tr.clear();
    tr.apply({ type: 'agent_settled' });
    expect(tr.items()).toEqual([]);
  });

  it('records a proposal card with valid, capped task ids, and skips an empty one', () => {
    const tr = createTranscript();
    tr.pushProposal([]);
    tr.pushProposal(['BAD ID']);
    expect(tr.items()).toEqual([]);
    const many = Array.from({ length: WORKBENCH_LIMITS.tasksPerProposal + 3 }, (_, i) => `t${i}`);
    tr.pushProposal(['ok1', 'BAD ID', ...many]);
    const [card] = tr.items();
    expect(card).toMatchObject({ kind: 'proposal' });
    const ids = (card as { taskIds: string[] }).taskIds;
    expect(ids[0]).toBe('ok1');
    expect(ids).not.toContain('BAD ID');
    expect(ids).toHaveLength(WORKBENCH_LIMITS.tasksPerProposal);
  });
});

describe('task updates and saved sessions', () => {
  const update = (tasks: unknown) => ({
    role: 'custom',
    customType: TASK_UPDATE_MESSAGE,
    content: '[AiOpt task update] worker output that must not reach the UI',
    display: true,
    details: { tasks },
  });

  it('shows a task update as titles and statuses only, never its text', () => {
    const t = createTranscript();
    t.apply({ type: 'message_start', message: update([{ title: 'Fix\u0007  bug', status: 'review' }, { title: 'x', status: 'bogus' }]) });
    expect(t.items()).toEqual([{ kind: 'taskUpdate', id: expect.any(String), tasks: [{ title: 'Fix bug', status: 'review' }] }]);
    expect(JSON.stringify(t.items())).not.toContain('worker output');
  });

  it('ignores other custom messages and empty updates', () => {
    const t = createTranscript();
    t.apply({ type: 'message_start', message: { role: 'custom', customType: 'other', content: 'x', details: {} } });
    t.apply({ type: 'message_start', message: update([]) });
    expect(t.items()).toEqual([]);
  });

  it('rebuilds a saved conversation, pairing tool results with their calls', () => {
    const t = createTranscript();
    t.apply({ type: 'agent_start' });
    t.load([
      { role: 'user', content: [{ type: 'text', text: 'plan it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Planning.' },
          { type: 'toolCall', id: 'c1', name: PROPOSE_TASKS_TOOL, arguments: { tasks: [] } },
        ],
      },
      { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false },
      update([{ title: 'A', status: 'failed' }]),
      { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom' },
      null,
      { role: 'system', content: 'ignored' },
    ]);
    expect(t.streaming()).toBe(false);
    expect(t.items().map((item) => item.kind)).toEqual(['user', 'assistant', 'tool', 'taskUpdate', 'error']);
    expect(t.items()[1]).toMatchObject({ text: 'Planning.', thinking: 'hmm', streaming: false });
    expect(t.items()[2]).toMatchObject({ id: 'c1', result: 'ok', done: true, isError: false });
    expect(t.items()[4]).toMatchObject({ message: 'boom' });
  });
});

describe('extractProposedTasks', () => {
  it('sanitizes, trims, caps, and drops invalid entries', () => {
    const tasks = extractProposedTasks({
      tasks: [
        { title: '  Fix\u001b[31m bug \n now ', prompt: 'do it\r\nplease' },
        { title: '', prompt: 'no title' },
        { title: 'no prompt' },
        'junk',
        { title: 'x'.repeat(500), prompt: 'y', folder: ' app ' },
      ],
    });
    expect(tasks).toEqual([
      { title: 'Fix[31m bug now', prompt: 'do it\nplease', folder: null, dependsOnTitles: [], dependsOnIds: [] },
      {
        title: 'x'.repeat(WORKBENCH_LIMITS.taskTitle),
        prompt: 'y',
        folder: 'app',
        dependsOnTitles: [],
        dependsOnIds: [],
      },
    ]);
  });

  it('parses dependency hints on proposals', () => {
    expect(
      extractProposedTasks({
        tasks: [
          {
            title: 'B',
            prompt: 'p',
            depends_on_titles: ['A', 'A'],
            depends_on_ids: ['abc123', 'bad-id'],
          },
        ],
      }),
    ).toEqual([
      {
        title: 'B',
        prompt: 'p',
        folder: null,
        dependsOnTitles: ['A'],
        dependsOnIds: ['abc123'],
      },
    ]);
  });

  it('keeps at most tasksPerProposal tasks and tolerates junk details', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, prompt: 'p' }));
    expect(extractProposedTasks({ tasks: many })).toHaveLength(WORKBENCH_LIMITS.tasksPerProposal);
    expect(extractProposedTasks(null)).toEqual([]);
    expect(extractProposedTasks({ tasks: 'no' })).toEqual([]);
  });
});

describe('complete_tasks', () => {
  it('extracts the ids the coordinator asked to complete, and nothing from a failed call', () => {
    const tr = createTranscript();
    const end = (isError: boolean) => ({
      type: 'tool_execution_end',
      toolCallId: 'k',
      toolName: COMPLETE_TASKS_TOOL,
      result: { details: { task_ids: ['aa', 'BAD ID', 'bb'] } },
      isError,
    });
    expect(tr.apply(end(false))).toEqual({ proposed: [], launchTaskIds: [], completeTaskIds: ['aa', 'bb'] });
    expect(tr.apply(end(true)).completeTaskIds).toEqual([]);
  });
});

describe('extractLaunchTaskIds', () => {
  it('keeps valid opaque ids only, capped at tasksPerProposal', () => {
    const many = Array.from({ length: 30 }, (_, i) => `id${i}`);
    expect(extractLaunchTaskIds({ task_ids: many })).toHaveLength(WORKBENCH_LIMITS.tasksPerProposal);
    expect(extractLaunchTaskIds({ task_ids: ['a1', 'BAD-ID', null, 3] })).toEqual(['a1']);
    expect(extractLaunchTaskIds(null)).toEqual([]);
    expect(extractLaunchTaskIds({ task_ids: 'no' })).toEqual([]);
  });
});
