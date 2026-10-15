import { describe, expect, it } from 'vitest';
import {
  buildRun,
  conversation,
  conversationID,
  joinSplitCalls,
  toolsOf,
  type ChatRequest,
} from '../cursor/conversation';
import { field, fields, pbNum, pbStr } from '../cursor/protobuf';

const tool = {
  type: 'function',
  function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
};

describe('toolsOf', () => {
  it('lists function tools, honoring tool_choice none / a named one', () => {
    const other = { type: 'function', function: { name: 'write' } };
    expect(toolsOf({ tools: [tool, other] }).map((t) => t.name)).toEqual(['read', 'write']);
    expect(toolsOf({ tools: [tool], tool_choice: 'none' })).toEqual([]);
    expect(
      toolsOf({ tools: [tool, other], tool_choice: { type: 'function', function: { name: 'write' } } }).map((t) => t.name),
    ).toEqual(['write']);
    expect(toolsOf({ tools: [other] })[0]!.schema).toEqual({ type: 'object', properties: {} });
  });
});

describe('joinSplitCalls', () => {
  it('joins an assistant message onto a previous one that made tool calls', () => {
    const out = joinSplitCalls([
      { role: 'assistant', content: 'a', tool_calls: [{ id: '1' }] },
      { role: 'assistant', content: 'b', tool_calls: [{ id: '2' }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe('a\n\nb');
    expect((out[0]!.tool_calls as unknown[]).length).toBe(2);
  });
});

describe('conversation', () => {
  const chat: ChatRequest = {
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
          { id: 'c2', type: 'function', function: { name: 'read', arguments: '{"path":"b"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'A' },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
    ],
    tools: [tool],
  };

  it('builds AI SDK messages with the tool catalog and answers unanswered calls', () => {
    const conv = conversation(chat, toolsOf(chat));
    const msgs = conv.msgs.map((b) => JSON.parse(b.toString()) as { role: string; content: unknown });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(String(msgs[0]!.content)).toContain('Be brief.');
    expect(String(msgs[0]!.content)).toContain('<dynamic_tool_catalog>');
    const results = msgs[3]!.content as Array<{ toolCallId: string; isError?: boolean }>;
    expect(results.map((r) => [r.toolCallId, !!r.isError])).toEqual([
      ['c1', false],
      ['c2', true],
    ]);
    const call = (msgs[2]!.content as Array<{ type: string; args?: unknown }>).find((p) => p.type === 'tool-call');
    expect(call!.args).toEqual({ namespace: 'aiopt', toolName: 'read', arguments: { path: 'a' } });
    expect(conv.last).toBe('thanks');
    expect(conv.estimate).toBeGreaterThan(0);
  });

  it('keeps a data-URL image as bytes', () => {
    const conv = conversation(
      {
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAEC' } }] },
        ],
      },
      [],
    );
    const user = JSON.parse(conv.msgs[0]!.toString()) as { content: Array<{ type: string; image?: { hex: string } }> };
    expect(user.content[0]).toMatchObject({ type: 'image', image: { hex: '000102' } });
  });
});

describe('conversationID', () => {
  it('is stable for a prompt_cache_key and empty without one', () => {
    const chat = { prompt_cache_key: 'k', messages: [{ role: 'user', content: 'hi' }] };
    expect(conversationID(chat)).toBe(conversationID({ ...chat }));
    expect(conversationID(chat)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(conversationID({ messages: [] })).toBe('');
  });
});

describe('buildRun', () => {
  it('lays out the run request and keys its blobs by sha256', () => {
    const chat: ChatRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [tool] };
    const tools = toolsOf(chat);
    const { first, blobs } = buildRun(conversation(chat, tools), tools, 'gpt-5', 'conv-1', {
      maxMode: true,
      params: [{ id: 'effort', value: 'high' }],
    });
    const rr = fields(field(fields(first), 1)!.data);
    const state = fields(field(rr, 1)!.data);
    // system (catalog) + user message blobs, the turn blob and the user blob behind it
    expect(blobs.size).toBe(4);
    for (const f of state.filter((x) => x.num === 1 || x.num === 8)) {
      expect(blobs.has(f.data.toString('hex'))).toBe(true);
    }
    expect(pbStr(state, 22)).toBe('cli');
    expect(pbStr(rr, 5)).toBe('conv-1');
    expect(pbNum(rr, 19)).toBe(1);
    const details = fields(field(rr, 3)!.data);
    expect(pbStr(details, 1)).toBe('gpt-5');
    expect(pbNum(details, 7)).toBe(1);
    const requested = fields(field(rr, 9)!.data);
    expect(pbNum(requested, 2)).toBe(1);
    const param = fields(field(requested, 3)!.data);
    expect([pbStr(param, 1), pbStr(param, 2)]).toEqual(['effort', 'high']);
    const mcp = fields(field(rr, 4)!.data);
    expect(pbStr(fields(field(mcp, 1)!.data), 1)).toBe('read');
  });
});
