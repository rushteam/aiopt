import { describe, expect, it } from 'vitest';
import { layoutTaskDag } from '../taskDagLayout';
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
