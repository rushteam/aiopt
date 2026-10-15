import { describe, expect, it } from 'vitest';
import { layoutTaskDag } from '../taskDagLayout';
import { planProgress, shouldShowTaskPlan } from '../workbench';
import type { TaskView } from '../workbench';

function task(id: string, dependsOn: string[] = []): TaskView {
  return {
    id,
    title: id,
    prompt: 'p',
    status: 'proposed',
    origin: 'user',
    folderId: null,
    isolated: false,
    branch: null,
    worktreeDisplay: null,
    agentName: null,
    failure: null,
    dependsOn,
    conversationId: null,
    approved: false,
    thread: [],
    workerOutput: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('layoutTaskDag', () => {
  it('layers a simple chain', () => {
    const layout = layoutTaskDag([task('a'), task('b', ['a']), task('c', ['b'])]);
    expect(layout.nodes.find((n) => n.id === 'a')?.layer).toBe(0);
    expect(layout.nodes.find((n) => n.id === 'b')?.layer).toBe(1);
    expect(layout.nodes.find((n) => n.id === 'c')?.layer).toBe(2);
    expect(layout.edges).toEqual([
      { fromId: 'a', toId: 'b' },
      { fromId: 'b', toId: 'c' },
    ]);
  });

  it('places parallel roots on the same layer', () => {
    const layout = layoutTaskDag([task('a'), task('b'), task('c', ['a', 'b'])]);
    expect(layout.nodes.filter((n) => n.layer === 0).map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(layout.nodes.find((n) => n.id === 'c')?.layer).toBe(1);
  });
});

describe('shouldShowTaskPlan', () => {
  it('hides the plan for a single task with no dependencies', () => {
    expect(shouldShowTaskPlan([task('a')])).toBe(false);
  });

  it('shows the plan for multiple tasks or any dependency', () => {
    expect(shouldShowTaskPlan([task('a'), task('b')])).toBe(true);
    expect(shouldShowTaskPlan([task('a', ['b']), task('b')])).toBe(true);
  });
});

describe('planProgress', () => {
  const t = (status: TaskView['status'], approved = false) => ({ status, approved });

  it('counts each state and names where the plan stands', () => {
    expect(planProgress([]).state).toBe('empty');
    expect(planProgress([t('proposed'), t('proposed')])).toMatchObject({ state: 'idle', awaitingApproval: 2 });
    expect(planProgress([t('done'), t('working'), t('proposed', true)])).toMatchObject({
      state: 'running',
      done: 1,
      live: 1,
      queued: 1,
    });
    expect(planProgress([t('done'), t('done')])).toMatchObject({ state: 'complete', done: 2, total: 2 });
  });

  it('is stalled when nothing can move without the user', () => {
    expect(planProgress([t('done'), t('failed')])).toMatchObject({ state: 'stalled', attention: 1 });
    expect(planProgress([t('done'), t('proposed')]).state).toBe('stalled');
  });
});
