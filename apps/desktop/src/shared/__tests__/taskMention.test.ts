import { describe, expect, it } from 'vitest';
import { expandTaskMentions, parseTaskMentionDrag, taskMentionToken } from '../taskMention';

describe('taskMention', () => {
  it('builds and expands tokens', () => {
    const id = 'a1b2c3d4';
    expect(taskMentionToken(id)).toBe('@task:a1b2c3d4');
    const out = expandTaskMentions(`See ${taskMentionToken(id)} please`, [
      { id, title: 'Fix bug', status: 'working' },
    ]);
    expect(out).toContain('@Fix bug');
    expect(out).toContain(id);
    expect(out).toContain('working');
  });

  it('leaves unknown ids unchanged', () => {
    expect(expandTaskMentions('@task:unknown1', [])).toBe('@task:unknown1');
  });

  it('parses drag payload', () => {
    expect(parseTaskMentionDrag(JSON.stringify({ id: 'abc123', title: 'T' }))).toEqual({ id: 'abc123', title: 'T' });
    expect(parseTaskMentionDrag('not json')).toBeNull();
    expect(parseTaskMentionDrag(JSON.stringify({ id: 'BAD', title: 'T' }))).toBeNull();
  });
});
