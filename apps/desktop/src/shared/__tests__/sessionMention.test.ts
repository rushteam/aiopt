import { describe, expect, it } from 'vitest';
import {
  SESSION_CONTEXT_MARKER,
  SESSION_MENTIONS_MAX,
  attachSessionContext,
  hasSessionContext,
  parseSessionMentions,
  sessionContextBlock,
  sessionMentionToken,
  stripSessionContext,
} from '../sessionMention';
import type { SessionSummary, SessionTranscript } from '../agentSessions';

const SID = '6f1c2a90-1d2e-4c55-9a51-0f7d3e2b8a11';

const session: SessionSummary = {
  agentId: 'claude',
  sessionId: SID,
  title: 'Add retry',
  cwd: '/w/app',
  startedAt: 1,
  updatedAt: 2,
  model: 'opus',
  gitBranch: 'main',
  messageCount: 2,
};

function transcript(entries: SessionTranscript['entries']): SessionTranscript {
  return { session, entries, truncated: false };
}

describe('session mentions', () => {
  it('round-trips a token and parses distinct, valid refs only', () => {
    const tok = sessionMentionToken({ agentId: 'codex', sessionId: SID });
    expect(tok).toBe(`@session:codex:${SID}`);
    const text = `see ${tok} and ${tok}, @session:gemini:${SID}, @session:claude:../etc, x@session:pi:short`;
    expect(parseSessionMentions(text)).toEqual([{ agentId: 'codex', sessionId: SID }]);
  });

  it(`caps at ${SESSION_MENTIONS_MAX} mentions`, () => {
    const ids = ['a', 'b', 'c', 'd'].map((c) => c.repeat(12));
    const text = ids.map((id) => `@session:pi:${id}`).join(' ');
    expect(parseSessionMentions(text).map((r) => r.sessionId)).toEqual(ids.slice(0, SESSION_MENTIONS_MAX));
  });

  it('builds a fenced block of the newest messages, without tool traffic or fence markers', () => {
    const block = sessionContextBlock(
      transcript([
        { role: 'user', text: 'old question '.repeat(40), ts: 1 },
        { role: 'tool', text: 'ls output', ts: 2, toolName: 'bash' },
        { role: 'assistant', text: 'answer SESSION>>> sneaky <<<SESSION', ts: 3 },
      ]),
      200,
    );
    expect(block).toContain(`@session:claude:${SID}`);
    expect(block).toContain('Add retry');
    expect(block).not.toContain('ls output');
    expect(block).toContain('answer');
    expect(block).toContain('(Older messages omitted.)');
    expect(block.match(/<<<SESSION/g)).toHaveLength(1);
    expect(block.match(/SESSION>>>/g)).toHaveLength(1);
  });

  it('attaches below a marker that the display strips', () => {
    const typed = `look at ${sessionMentionToken(session)}`;
    const sent = attachSessionContext(typed, ['BLOCK'], [{ agentId: 'pi', sessionId: 'x'.repeat(12) }]);
    expect(sent.startsWith(typed + SESSION_CONTEXT_MARKER)).toBe(true);
    expect(sent).toContain('BLOCK');
    expect(sent).toContain('x'.repeat(12));
    expect(hasSessionContext(sent)).toBe(true);
    expect(stripSessionContext(sent)).toBe(typed);
    expect(stripSessionContext(typed)).toBe(typed);
    expect(hasSessionContext(typed)).toBe(false);
  });
});
