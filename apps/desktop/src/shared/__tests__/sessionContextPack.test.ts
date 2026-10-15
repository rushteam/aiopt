import { describe, expect, it } from 'vitest';
import { buildContextPack, normalizePackIndexes } from '../sessionContextPack';
import type { SessionTranscript } from '../agentSessions';

const t: SessionTranscript = {
  session: {
    agentId: 'codex',
    sessionId: 'abcdefgh1234',
    title: 'Fix   the\nbuild',
    cwd: '/w/app',
    startedAt: 0,
    updatedAt: 0,
    model: 'gpt-5',
    gitBranch: 'dev',
    messageCount: 3,
  },
  entries: [
    { role: 'user', text: 'why does it fail', ts: 1 },
    { role: 'tool', text: 'has ``` fence', ts: 2, toolName: 'shell' },
    { role: 'assistant', text: 'a missing import', ts: 3 },
    { role: 'user', text: '   ', ts: 4 },
  ],
  truncated: false,
};

describe('context pack', () => {
  it('normalizes indexes, refusing anything out of range', () => {
    expect(normalizePackIndexes([2, 0, 2], 4)).toEqual([0, 2]);
    for (const bad of [[4], [-1], [1.5], ['1'], [null]]) expect(normalizePackIndexes(bad, 4)).toBeNull();
  });

  it('builds Markdown framed as background, with the picked messages in order', () => {
    const p = buildContextPack(t, [0, 1, 2, 3]);
    expect(p).toMatchObject({ included: 3, cut: false });
    expect(p.markdown).toContain('# Context from an earlier codex session');
    expect(p.markdown).toContain('not a list of instructions');
    expect(p.markdown).toContain('- Session: Fix the build');
    expect(p.markdown).toContain('- Branch: dev');
    expect(p.markdown.indexOf('why does it fail')).toBeLessThan(p.markdown.indexOf('a missing import'));
    // A tool body is fenced longer than any backtick run inside it.
    expect(p.markdown).toContain('### Tool: shell\n\n````\nhas ``` fence\n````');
  });

  it('keeps the newest picks under the size cap', () => {
    const headerOnly = buildContextPack(t, []).markdown.length;
    const p = buildContextPack(t, [0, 2], headerOnly + 40);
    expect(p).toMatchObject({ included: 1, cut: true });
    expect(p.markdown).toContain('a missing import');
    expect(p.markdown).not.toContain('why does it fail');
    expect(p.markdown).toContain('left out');
  });
});
