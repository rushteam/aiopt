import { describe, expect, it } from 'vitest';
import {
  claudeTranscript,
  codexTranscript,
  cursorTranscript,
  estimateTokens,
  piTranscript,
  protobufFields,
  scanClaudeLines,
  scanCodexLines,
  scanCursorChat,
  scanPiLines,
  type CursorChatSource,
  TITLE_MAX,
  TOOL_TEXT_MAX,
} from '../sessionParsers';
import { dayKey } from '../../../shared/usageStats';

const SID = '6f1c2a90-1d2e-4c55-9a51-0f7d3e2b8a11';
const T0 = '2025-06-30T10:00:00.000Z';
const T1 = '2025-06-30T10:05:00.000Z';
// Usage buckets by the LOCAL day of the system zone, so the expected key follows the zone.
const T1_DAY = dayKey(Date.parse(T1));

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
        day: T1_DAY,
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
        day: T1_DAY,
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

// ---------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------

const PID = '01a13d91-44b5-76cc-b5d9-d8e7452ddf56';
const piUsage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const piLines = [
  { type: 'session', version: 3, id: PID, timestamp: T0, cwd: '/w/pi' },
  { type: 'model_change', id: 'a1', parentId: null, timestamp: T0, provider: 'anthropic', modelId: 'claude-opus-4-5' },
  { type: 'message', id: 'a2', parentId: 'a1', timestamp: T0, message: { role: 'system', content: 'You are…', timestamp: 0 } },
  { type: 'message', id: 'a3', parentId: 'a2', timestamp: T0, message: { role: 'user', content: [{ type: 'text', text: 'Fix   the\nbuild' }], timestamp: 0 } },
  {
    type: 'message', id: 'a4', parentId: 'a3', timestamp: T1,
    message: {
      role: 'assistant', model: 'claude-opus-4-5', usage: piUsage(4, 10, 100, 20),
      content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }],
    },
  },
  { type: 'message', id: 'a5', parentId: 'a4', timestamp: T1, message: { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'a.ts' }], isError: false } },
  { type: 'message', id: 'a6', parentId: 'a5', timestamp: T1, message: { role: 'assistant', model: 'claude-opus-4-5', usage: piUsage(1, 2), content: [{ type: 'text', text: 'Fixed.' }] } },
  { type: 'message', id: 'a7', parentId: 'a6', timestamp: T1, message: { role: 'bashExecution', command: 'pwd', output: '/w/pi', exitCode: 0 } },
  { type: 'usage', id: 'a8', parentId: 'a7', timestamp: T1, kind: 'cache_warm', model: 'claude-opus-4-5', usage: piUsage(0, 0, 50, 0) },
  { type: 'compaction', id: 'a9', parentId: 'a8', timestamp: T1, summary: 's', firstKeptEntryId: 'a3', tokensBefore: 9, usage: piUsage(5, 5) },
  { type: 'message', id: 'b1', parentId: 'a9', timestamp: T1, message: { role: 'assistant', model: 'claude-opus-4-5', usage: piUsage(1, 1), content: [{ type: 'text', text: 'x' }], stopReason: 'error' } },
  '{torn',
];

describe('scanPiLines', () => {
  it('reads the header, the user title and every billed usage entry', () => {
    const { summary, usage } = scanPiLines(piLines, 'fb');
    expect(summary).toMatchObject({
      agentId: 'pi',
      sessionId: PID,
      cwd: '/w/pi',
      title: 'Fix the build',
      model: 'claude-opus-4-5',
      startedAt: Date.parse(T0),
      updatedAt: Date.parse(T1),
      messageCount: 3,
    });
    expect(usage).toEqual([
      {
        day: T1_DAY,
        agentId: 'pi',
        model: 'claude-opus-4-5',
        responses: 5,
        inputTokens: 4 + 1 + 0 + 5 + 1,
        outputTokens: 10 + 2 + 0 + 5 + 1,
        cacheReadTokens: 100 + 50,
        cacheWriteTokens: 20,
      },
    ]);
  });

  it('prefers the user-set session name and falls back to the file id', () => {
    const named = scanPiLines([...piLines, { type: 'session_info', timestamp: T1, name: 'Build fix' }], 'fb');
    expect(named.summary!.title).toBe('Build fix');
    const headless = scanPiLines(piLines.slice(1), 'from-file');
    expect(headless.summary!.sessionId).toBe('from-file');
  });

  it('renders text, tool calls, tool results and shell runs', () => {
    const entries = piTranscript(piLines);
    expect(entries.map((e) => [e.role, e.toolName ?? '', e.text])).toEqual([
      ['user', '', 'Fix   the\nbuild'],
      ['tool', 'bash', JSON.stringify({ command: 'ls' }, null, 2)],
      ['tool', 'bash', 'a.ts'],
      ['assistant', '', 'Fixed.'],
      ['tool', 'bash', '$ pwd\n/w/pi'],
      ['assistant', '', 'x'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** Encode protobuf fields (varint / length-delimited only — all the root node uses). */
function pb(fields: Array<[number, number | Uint8Array]>): Uint8Array {
  const out: number[] = [];
  const varint = (n: number) => {
    while (n >= 0x80) {
      out.push((n % 128) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(n);
  };
  for (const [field, value] of fields) {
    if (typeof value === 'number') {
      varint(field * 8);
      varint(value);
    } else {
      varint(field * 8 + 2);
      varint(value.length);
      out.push(...value);
    }
  }
  return Uint8Array.from(out);
}

const CHAT = '613ef075-bfd0-4255-8401-124396c4bc78';
const utf8 = (s: string) => new TextEncoder().encode(s);
const idOf = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0xab));
const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');

function cursorSource(over: { meta?: Record<string, unknown> | string; root?: Uint8Array | null } = {}): CursorChatSource {
  const messages = [
    { role: 'system', content: 'You are an AI coding assistant.' },
    { role: 'user', content: '<user_info>\nOS Version: darwin\n</user_info>' },
    { role: 'user', content: [{ type: 'text', text: '<user_query>\nAdd a  trie\n</user_query>' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'On it.' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'LS', args: { target_directory: '/w' } },
      ],
      providerOptions: { cursor: { modelName: 'claude-4.5-opus-high-thinking' } },
    },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'LS', result: 'a.go' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Found a.go.', providerOptions: { cursor: { modelName: 'gpt-5' } } }] },
  ];
  const blobs = new Map<string, Uint8Array>();
  const refs: Array<[number, Uint8Array]> = [];
  messages.forEach((m, i) => {
    blobs.set(hexOf(idOf(i)), utf8(JSON.stringify(m)));
    refs.push([1, idOf(i)]);
  });
  refs.push([1, idOf(99)]); // dangling reference — skipped
  const root = over.root === undefined ? pb([...refs, [5, pb([[1, 6000], [2, 176000]])], [9, utf8('file:///w/my%20app')], [10, 1]]) : over.root;
  if (root) blobs.set('ff'.repeat(32), root);
  const meta =
    typeof over.meta === 'string'
      ? over.meta
      : Buffer.from(
          JSON.stringify({ agentId: CHAT, latestRootBlobId: 'ff'.repeat(32), name: 'Trie search', createdAt: Date.parse(T0), lastUsedModel: 'claude-4.5-opus', ...over.meta }),
        ).toString('hex');
  return { meta, blob: (id) => blobs.get(id) ?? null, fallbackId: 'dir-id', mtimeMs: Date.parse(T1) + 0.5 };
}

describe('estimateTokens', () => {
  it('counts ~4 Latin characters or 1 CJK character per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('统计页面')).toBe(4);
    expect(estimateTokens('写 go')).toBe(2);
  });
});

describe('protobufFields', () => {
  it('reads varint and length-delimited fields and rejects malformed input', () => {
    expect(protobufFields(pb([[1, 300], [2, utf8('hi')]]))).toEqual([
      { field: 1, value: 300 },
      { field: 2, value: utf8('hi') },
    ]);
    expect(protobufFields(Uint8Array.from([0x0a, 0x05, 0x01]))).toBeNull(); // length past the end
    expect(protobufFields(Uint8Array.from([0x0b]))).toBeNull(); // wire type 3
    expect(protobufFields(Uint8Array.from([0x08, 0xff]))).toBeNull(); // torn varint
  });
});

describe('scanCursorChat', () => {
  it('builds a summary from meta + root, with per-model estimated usage', () => {
    const { summary, usage } = scanCursorChat(cursorSource());
    expect(summary).toEqual({
      agentId: 'cursor',
      sessionId: CHAT,
      title: 'Trie search',
      cwd: '/w/my app',
      startedAt: Date.parse(T0),
      updatedAt: Date.parse(T1),
      model: 'claude-4.5-opus',
      gitBranch: '',
      messageCount: 3,
    });
    expect(usage.map((r) => [r.model, r.responses])).toEqual([
      ['claude-4.5-opus-high-thinking', 1],
      ['gpt-5', 1],
    ]);
  });

  it('estimates usage: prompt = history + overhead calibrated to the recorded context, prefix as cache', () => {
    const src = cursorSource();
    const { usage } = scanCursorChat(src);
    const [first, second] = usage;
    // The recorded context (6000) is the estimated final context: overhead + all messages.
    const total = (r: (typeof usage)[number]) => r.inputTokens + r.cacheReadTokens;
    expect(total(second!) + second!.outputTokens).toBe(6000);
    // Reply 1 sees no earlier prompt; reply 2 re-reads everything reply 1 saw and wrote.
    expect(first!.cacheReadTokens).toBe(0);
    expect(second!.cacheReadTokens).toBe(total(first!) + first!.outputTokens);
    expect(second!.inputTokens).toBeGreaterThan(0); // the tool result is new
    // Both responses fall inside [created, updated], so on the creation / update days.
    expect(usage.every((r) => r.day === dayKey(Date.parse(T0)) || r.day === T1_DAY)).toBe(true);
  });

  it('estimates nothing for a chat without replies', () => {
    const blobs = new Map<string, Uint8Array>([
      [hexOf(idOf(0)), utf8(JSON.stringify({ role: 'user', content: '<user_query>hi</user_query>' }))],
      ['ff'.repeat(32), pb([[1, idOf(0)]])],
    ]);
    const src = { ...cursorSource(), blob: (id: string) => blobs.get(id) ?? null };
    expect(scanCursorChat(src).usage).toEqual([]);
  });

  it('titles an unnamed chat by the first user query', () => {
    expect(scanCursorChat(cursorSource({ meta: { name: '' } })).summary!.title).toBe('Add a trie');
  });

  it('accepts plain JSON meta and tolerates a missing or corrupt root', () => {
    const plain = cursorSource({ meta: JSON.stringify({ agentId: CHAT, latestRootBlobId: 'ff'.repeat(32) }) });
    expect(scanCursorChat(plain).summary!.sessionId).toBe(CHAT);
    expect(scanCursorChat(cursorSource({ root: null })).summary).toBeNull();
    expect(scanCursorChat(cursorSource({ root: Uint8Array.from([0x0a, 0x7f]) })).summary).toBeNull();
    expect(scanCursorChat(cursorSource({ meta: 'zz-not-json' })).summary).toBeNull();
  });

  it('renders the user query, assistant text and tool traffic (no reasoning, no injected context)', () => {
    expect(cursorTranscript(cursorSource()).map((e) => [e.role, e.toolName ?? '', e.text])).toEqual([
      ['user', '', 'Add a  trie'],
      ['assistant', '', 'On it.'],
      ['tool', 'LS', JSON.stringify({ target_directory: '/w' }, null, 2)],
      ['tool', 'LS', 'a.go'],
      ['assistant', '', 'Found a.go.'],
    ]);
  });
});
