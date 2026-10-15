import { describe, expect, it } from 'vitest';
import { WORKBENCH_LIMITS, type TaskStatus, type TaskView } from '../../../../shared/workbench';
import { proposalBlocker } from '../proposalBlocker';

function task(id: string, status: TaskStatus = 'proposed', dependsOn: string[] = []): TaskView {
  return {
    id,
    title: id,
    prompt: 'p',
    status,
    origin: 'orchestrator',
    folderId: 'f1',
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

const folders = [{ id: 'f1', name: 'app', displayPath: '~/app', isGitRepo: true }];
const ready = { status: 'ready' as const, herdrAvailable: true, folders };

describe('proposalBlocker', () => {
  it('lets a task with a folder and no open dependencies run', () => {
    const a = task('a');
    expect(proposalBlocker(a, { ...ready, tasks: [a] })).toBeNull();
  });

  it('needs a running workbench with herdr', () => {
    const a = task('a');
    expect(proposalBlocker(a, { ...ready, status: 'stopped', tasks: [a] })).toBe('session');
    expect(proposalBlocker(a, { ...ready, herdrAvailable: false, tasks: [a] })).toBe('session');
  });

  it('needs a folder that is still granted', () => {
    const a = { ...task('a'), folderId: null };
    expect(proposalBlocker(a, { ...ready, tasks: [a] })).toBe('folder');
    const gone = { ...task('b'), folderId: 'removed' };
    expect(proposalBlocker(gone, { ...ready, tasks: [gone] })).toBe('folder');
  });

  it('waits for dependencies to be done', () => {
    const dep = task('dep');
    const b = task('b', 'proposed', ['dep']);
    expect(proposalBlocker(b, { ...ready, tasks: [dep, b] })).toBe('dependencies');
    expect(proposalBlocker(b, { ...ready, tasks: [{ ...dep, status: 'done' }, b] })).toBeNull();
  });

  it('respects the live task limit', () => {
    const live = Array.from({ length: WORKBENCH_LIMITS.liveTasks }, (_, i) => task(`w${i}`, 'working'));
    const a = task('a');
    expect(proposalBlocker(a, { ...ready, tasks: [...live, a] })).toBe('limit');
  });
});
