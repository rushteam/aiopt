import { describe, expect, it } from 'vitest';
import { replyAfterTools, unflagged, workbuddyBody } from '../workbuddy/body';

describe('workbuddyBody', () => {
  it('adds a system message, streams, and renames developer / max_completion_tokens', () => {
    const input = { model: 'glm-5.3', max_completion_tokens: 9, messages: [{ role: 'developer', content: 'be brief' }, { role: 'user', content: 'hi' }] };
    const { body } = workbuddyBody(input);
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_tokens: 9 });
    expect(body.max_completion_tokens).toBeUndefined();
    expect((body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(['system', 'user']);
    expect(input.messages[0]!.role).toBe('developer'); // input untouched
    const plain = workbuddyBody({ messages: [{ role: 'user', content: 'hi' }] }).body;
    expect((plain.messages as Array<{ role: string }>)[0]!.role).toBe('system');
  });

  it("rewrites flagged words and drops Claude Code's billing header line", () => {
    expect(unflagged('x-anthropic-billing-header: cc=1\nYou are Claude Code, Anthropic\'s official CLI for Claude.')).toBe(
      "You are Claude Code, Anthropic's CLI for Claude.",
    );
    const { body } = workbuddyBody({ messages: [{ role: 'system', content: [{ type: 'text', text: 'x-anthropic-billing-header: a' }] }, { role: 'user', content: 'q' }] });
    // the emptied system block went; a default one takes its place
    expect(body.messages).toEqual([{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'q' }]);
  });

  it('makes tool names safe and maps them back; fixes schemas', () => {
    const { body, names } = workbuddyBody({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'mcp.read', arguments: '{}' } }] },
      ],
      tools: [
        { type: 'function', function: { name: 'mcp.read', parameters: { type: 'object', properties: { m: { enum: ['a', 1] }, p: { type: 'string', pattern: 'a\\0b' } } } } },
        { type: 'function', function: { name: 'ok_name', parameters: { anyOf: [{ type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }] } } },
      ],
      tool_choice: { type: 'function', function: { name: 'mcp.read' } },
    });
    expect(names.get('mcp_read')).toBe('mcp.read');
    const tools = body.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
    expect(tools[0]!.function.name).toBe('mcp_read');
    const props = tools[0]!.function.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.m!.anyOf).toEqual([{ type: 'string', enum: ['a'] }, { type: 'integer', enum: [1] }]);
    expect(props.p!.pattern).toBe('a\\u0000b');
    expect(tools[1]!.function.parameters).toEqual({ type: 'object', properties: { x: { type: 'string' } }, required: ['x'] });
    expect(body.tool_choice).toBe('mcp_read');
    const asst = (body.messages as Array<{ tool_calls?: Array<{ function: { name: string } }> }>)[2]!;
    expect(asst.tool_calls![0]!.function.name).toBe('mcp_read');
  });

  it('drops tools for tool_choice none', () => {
    const { body } = workbuddyBody({ messages: [{ role: 'user', content: 'q' }], tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'none' });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('puts an empty reply between trailing tool results and the user', () => {
    const b = { messages: [{ role: 'tool', content: 'r' }, { role: 'user', content: 'go' }] };
    expect(replyAfterTools(b)!.messages).toEqual([{ role: 'tool', content: 'r' }, { role: 'assistant', content: '' }, { role: 'user', content: 'go' }]);
    expect(replyAfterTools({ messages: [{ role: 'user', content: 'go' }] })).toBeNull();
  });
});
