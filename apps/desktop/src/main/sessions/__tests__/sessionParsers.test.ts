import { describe, expect, it } from 'vitest';
import {
  claudeTranscript,
  codexTranscript,
  scanClaudeLines,
  scanCodexLines,
  TITLE_MAX,
  TOOL_TEXT_MAX,
} from '../sessionParsers';

const SID = '6f1c2a90-1d2e-4c55-9a51-0f7d3e2b8a11';
const T0 = '2025-06-30T10:00:00.000Z';
const T1 = '2025-06-30T10:05:00.000Z';

function assistantBlock(id: string, block: unknown, usage: Record<string, number>, model = 'claude-opus-4-5') {
  return {
    type: 'assistant',
    sessionId: SID,
    timestamp: T1,
    message: { id, model, content: [block], usage },
  };
}

const claudeLines = [
  { type: 'summary', summary: 'Fallback summary' },
  { type: 'user', sessionId: SID, cwd: '/w/app', gitBranch: 'main', timestamp: T0, isMeta: true, message: { content: '<command-name>/clear</command-name>' } },
  { type: 'user', sessionId: SID, cwd: '/w/app', gitBranch: 'main', timestamp: T0, message: { content: 'Add   retry\nto uploads' } },
  // One reply split into two content blocks that repeat the same usage.
  assistantBlock('msg_1', { type: 'text', text: 'Sure.' }, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
  assistantBlock('msg_1', { type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file: 'a.ts' } }, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
  { type: 'user', sessionId: SID, timestamp: T1, message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } },
  assistantBlock('msg_2', { type: 'text', text: 'Done.' }, { input_tokens: 1, output_tokens: 2 }),
  assistantBlock('msg_3', { type: 'text', text: 'API error' }, { input_tokens: 0, output_tokens: 0 }, '<synthetic>'),
  { type: 'assistant', isSidechain: true, sessionId: SID, timestamp: T1, message: { id: 'side', model: 'claude-opus-4-5', content: [{ type: 'text', text: 'side' }] } },
  'not an object',
  null,
];

describe('scanClaudeLines', () => {
  it('builds a summary and counts usage once per message id', () => {
    const { summary, usage } = scanClaudeLines(claudeLines, { listAsSession: true, fallbackId: 'fallback' });
    expect(summary).toMatchObject({
      agentId: 'claude',
      sessionId: SID,
      title: 'Add retry to uploads',
      cwd: '/w/app',
      gitBranch: 'main',
      model: 'claude-opus-4-5',
      startedAt: Date.parse(T0),
      updatedAt: Date.parse(T1),
    });
    // prompt, 'Sure.', 'Done.', 'API error' — the tool_use block and the sidechain line don't count
    expect(summary!.messageCount).toBe(4);
    expect(usage).toEqual([
      {
        day: '2025-06-30',
        agentId: 'claude',
        model: 'claude-opus-4-5',
        responses: 2,
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
      },
    ]);
  });

  it('falls back to the summary title and truncates long titles', () => {
    const noPrompt = scanClaudeLines(
      [{ type: 'summary', summary: 'Session summary' }, assistantBlock('m', { type: 'text', text: 'x' }, {})],
      { listAsSession: true, fallbackId: SID },
    );
    expect(noPrompt.summary!.title).toBe('Session summary');
    const long = scanClaudeLines(
      [{ type: 'user', sessionId: SID, timestamp: T0, message: { content: 'y'.repeat(500) } }],
      { listAsSession: true, fallbackId: SID },
    );
    expect(long.summary!.title).toHaveLength(TITLE_MAX);
  });

  it('subagent files contribute usage but no session', () => {
    const r = scanClaudeLines(claudeLines, { listAsSession: false, fallbackId: '' });
    expect(r.summary).toBeNull();
    expect(r.usage).toHaveLength(1);
  });

  it('renders a transcript with tool calls and results named', () => {
    const entries = claudeTranscript(claudeLines);
    expect(entries.map((e) => [e.role, e.toolName ?? '', e.text])).toEqual([
      ['user', '', 'Add   retry\nto uploads'],
      ['assistant', '', 'Sure.'],
      ['tool', 'Edit', JSON.stringify({ file: 'a.ts' }, null, 2)],
      ['tool', 'Edit', 'ok'],
      ['assistant', '', 'Done.'],
      ['assistant', '', 'API error'],
    ]);
  });
});

const CID = '0198a3c4-77e2-7b10-9c3d-5e6f7a8b9c0d';
const usageInfo = (total: number, last: Record<string, number>) => ({
  total_token_usage: { total_tokens: total },
  last_token_usage: last,
});
const codexLines = [
  { timestamp: T0, type: 'session_meta', payload: { id: CID, cwd: '/w/tools', git: { branch: 'dev' } } },
  { timestamp: T0, type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/w/tools' } },
  { timestamp: T0, type: 'event_msg', payload: { type: 'user_message', message: '<environment_context>…' } },
  { timestamp: T0, type: 'event_msg', payload: { type: 'user_message', message: 'Why is CI red?' } },
  { timestamp: T0, type: 'event_msg', payload: { type: 'token_count', info: null } },
  { timestamp: T1, type: 'event_msg', payload: { type: 'token_count', info: usageInfo(150, { input_tokens: 120, cached_input_tokens: 100, output_tokens: 30 }) } },
  // Re-emitted with the same running total — not a new response.
  { timestamp: T1, type: 'event_msg', payload: { type: 'token_count', info: usageInfo(150, { input_tokens: 120, cached_input_tokens: 100, output_tokens: 30 }) } },
  { timestamp: T1, type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"cmd":"ls"}' } },
  { timestamp: T1, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'x'.repeat(TOOL_TEXT_MAX + 50) } },
  { timestamp: T1, type: 'event_msg', payload: { type: 'agent_message', message: 'A flaky test.' } },
];

describe('scanCodexLines', () => {
  it('reads meta, model and per-response usage (cached tokens split out of input)', () => {
    const { summary, usage } = scanCodexLines(codexLines, 'fb');
    expect(summary).toMatchObject({
      agentId: 'codex',
      sessionId: CID,
      cwd: '/w/tools',
      gitBranch: 'dev',
      model: 'gpt-5-codex',
      messageCount: 3,
    });
    // The environment-context preamble is not a title.
    expect(summary!.title).toBe('Why is CI red?');
    expect(usage).toEqual([
      {
        day: '2025-06-30',
        agentId: 'codex',
        model: 'gpt-5-codex',
        responses: 1,
        inputTokens: 20,
        outputTokens: 30,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
      },
    ]);
  });

  it('no messages → no session', () => {
    expect(scanCodexLines([codexLines[0]], 'fb').summary).toBeNull();
  });

  it('renders a transcript and clips tool output', () => {
    const entries = codexTranscript(codexLines);
    expect(entries.map((e) => [e.role, e.toolName ?? ''])).toEqual([
      ['user', ''],
      ['user', ''],
      ['tool', 'shell'],
      ['tool', 'shell'],
      ['assistant', ''],
    ]);
    expect(entries[3]!.text.length).toBeLessThan(TOOL_TEXT_MAX + 5);
  });
});
