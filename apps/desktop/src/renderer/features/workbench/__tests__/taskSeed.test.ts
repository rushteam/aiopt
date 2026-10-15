import { describe, expect, it } from 'vitest';
import { taskSeedFromSession } from '../taskSeed';
import { parseSessionMentions } from '../../../../shared/sessionMention';
import { WORKBENCH_LIMITS } from '../../../../shared/workbench';

const SID = '6f1c2a90-1d2e-4c55-9a51-0f7d3e2b8a11';

describe('taskSeedFromSession', () => {
  it('references the session instead of copying its text', () => {
    const seed = taskSeedFromSession({ agentId: 'claude', sessionId: SID, title: '  Add\n retry  ' }, 'Untitled');
    expect(seed.title).toBe('Add retry');
    expect(parseSessionMentions(seed.prompt)).toEqual([{ agentId: 'claude', sessionId: SID }]);
    expect(seed.prompt.length).toBeLessThan(100);
  });

  it('falls back to the untitled label and caps the title', () => {
    expect(taskSeedFromSession({ agentId: 'codex', sessionId: SID, title: '' }, 'Untitled').title).toBe('Untitled');
    const long = taskSeedFromSession({ agentId: 'codex', sessionId: SID, title: 'x'.repeat(500) }, 'Untitled');
    expect(long.title.length).toBe(WORKBENCH_LIMITS.taskTitle);
  });
});
