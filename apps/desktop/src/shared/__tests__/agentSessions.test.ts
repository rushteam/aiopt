import { describe, expect, it } from 'vitest';
import {
  aggregateLocalUsage,
  isSessionAgentId,
  isSessionId,
  resumeCommand,
  transcriptToMarkdown,
  type LocalUsageRecord,
  type SessionTranscript,
} from '../agentSessions';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2025, 5, 30, 12);

function rec(day: string, agentId: 'claude' | 'codex', model: string, n: number): LocalUsageRecord {
  return { day, agentId, model, responses: 1, inputTokens: n, outputTokens: n, cacheReadTokens: n, cacheWriteTokens: n };
}

describe('session ids', () => {
  it('accepts uuids and rejects anything path-like', () => {
    expect(isSessionId('6f1c2a90-1d2e-4c55-9a51-0f7d3e2b8a11')).toBe(true);
    for (const bad of ['', 'short', '../../etc/passwd', 'a/b/c/d/e/f/g', '-leadingdash1', 'a'.repeat(80), 'x y z w v u', 7]) {
      expect(isSessionId(bad)).toBe(false);
    }
    expect(isSessionAgentId('claude')).toBe(true);
    expect(isSessionAgentId('gemini')).toBe(false);
  });
});

describe('aggregateLocalUsage', () => {
  it('sums totals, buckets and days; drops days outside the window', () => {
    const snap = aggregateLocalUsage(
      [
        [rec('2025-06-30', 'claude', 'opus', 10), rec('2025-06-29', 'claude', 'sonnet', 1)],
        [rec('2025-06-30', 'codex', 'gpt-5', 5)],
        [rec('2025-01-01', 'codex', 'gpt-5', 1000)], // outside a 90-day window
      ],
      { now: NOW, retentionDays: 90 },
    );
    expect(snap.totals).toEqual({
      responses: 3,
      inputTokens: 16,
      outputTokens: 16,
      cacheReadTokens: 16,
      cacheWriteTokens: 16,
      totalTokens: 64,
    });
    expect(snap.sessionCount).toBe(2);
    expect(snap.byAgent.map((b) => [b.key, b.totalTokens])).toEqual([
      ['claude', 44],
      ['codex', 20],
    ]);
    expect(snap.byModel[0]!.key).toBe('opus');
    expect(snap.daily.map((d) => d.day)).toEqual(['2025-06-29', '2025-06-30']);
    expect(snap.retentionDays).toBe(90);
  });

  it('keeps the first day of the window', () => {
    const first = new Date(NOW - 89 * DAY).toISOString().slice(0, 10);
    const snap = aggregateLocalUsage([[rec(first, 'claude', 'm', 1)]], { now: NOW, retentionDays: 90 });
    expect(snap.totals.responses).toBe(1);
  });
});

describe('resumeCommand', () => {
  const ref = { agentId: 'claude' as const, sessionId: '6f1c2a90-1d2e-4c55-9a51-0f7d3e2b8a11' };

  it('builds the per-agent command with a quoted cd on POSIX', () => {
    expect(resumeCommand(ref, "/Users/me/it's here", 'darwin')).toBe(
      `cd '/Users/me/it'\\''s here' && claude --resume ${ref.sessionId}`,
    );
    expect(resumeCommand({ ...ref, agentId: 'codex' }, '', 'linux')).toBe(`codex resume ${ref.sessionId}`);
  });

  it('uses PowerShell on Windows and drops a cwd it cannot quote', () => {
    expect(resumeCommand(ref, 'C:\\work\\app', 'win32')).toBe(
      `Set-Location -LiteralPath "C:\\work\\app"; claude --resume ${ref.sessionId}`,
    );
    expect(resumeCommand(ref, 'C:\\a"b', 'win32')).toBe(`claude --resume ${ref.sessionId}`);
    expect(resumeCommand(ref, 'C:\\$(evil)', 'win32')).toBe(`claude --resume ${ref.sessionId}`);
    expect(resumeCommand(ref, '/tmp/a\nrm -rf ~', 'darwin')).toBe(`claude --resume ${ref.sessionId}`);
  });

  it('refuses a malformed session id', () => {
    expect(() => resumeCommand({ ...ref, sessionId: '$(rm -rf ~)' }, '', 'darwin')).toThrow();
  });
});

describe('transcriptToMarkdown', () => {
  it('renders headings and fences tool text longer than any backtick run inside', () => {
    const t: SessionTranscript = {
      session: {
        agentId: 'codex',
        sessionId: '0198a3c4-77e2-7b10-9c3d-5e6f7a8b9c0d',
        title: 'Fix the build',
        cwd: '/w',
        startedAt: NOW,
        updatedAt: NOW,
        model: 'gpt-5',
        gitBranch: '',
        messageCount: 2,
      },
      entries: [
        { role: 'user', text: 'hi', ts: 0 },
        { role: 'tool', text: 'has ```` fence', ts: 0, toolName: 'shell' },
        { role: 'assistant', text: 'done', ts: 0 },
      ],
      truncated: true,
    };
    const md = transcriptToMarkdown(t);
    expect(md).toContain('# Fix the build');
    expect(md).toContain('- Directory: /w');
    expect(md).toContain('- Note: this transcript was shortened.');
    expect(md).toContain('## Tool: shell\n\n`````\nhas ```` fence\n`````');
    expect(md).toContain('## Assistant\n\ndone');
  });
});
