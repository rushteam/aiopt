import { describe, expect, it } from 'vitest';
import { kiroBody, kiroThinkingBudget, kiroToolId, kiroToolName } from '../kiro/body';

const parse = (chat: Record<string, unknown>, profile = 'arn:p') => JSON.parse(kiroBody(chat, profile, 'conv').body);

describe('Kiro body', () => {
  it('puts the system prompt at the head of the first message and ends with the current one', () => {
    const b = parse({
      model: 'claude-sonnet-4.5',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'again' },
      ],
    });
    expect(b.profileArn).toBe('arn:p');
    expect(b.conversationState.conversationId).toBe('conv');
    expect(b.conversationState.history[0].userInputMessage.content).toBe('be brief\n\nhi');
    expect(b.conversationState.history[1].assistantResponseMessage.content).toBe('hello');
    expect(b.conversationState.currentMessage.userInputMessage).toMatchObject({ content: 'again', modelId: 'claude-sonnet-4.5', origin: 'KIRO_CLI' });
  });

  it('answers each tool call in the next user message and declares tools', () => {
    const b = parse({
      model: 'auto',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } },
          { id: 'c2', type: 'function', function: { name: 'old.tool', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'c1', content: 'out' },
        { role: 'tool', tool_call_id: 'nope', content: 'stray' },
      ],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    });
    const cur = b.conversationState.currentMessage.userInputMessage;
    expect(cur.content).toBe('');
    expect(cur.userInputMessageContext.toolResults).toEqual([
      { toolUseId: 'c1', status: 'success', content: [{ text: 'out' }] },
      { toolUseId: 'c2', status: 'error', content: [{ text: 'Tool use was interrupted and did not produce a result.' }] },
    ]);
    const names = cur.userInputMessageContext.tools.map((t: { toolSpecification: { name: string } }) => t.toolSpecification.name);
    expect(names).toEqual(['read', kiroToolName('old.tool')]);
    expect(b.conversationState.history[1].assistantResponseMessage.toolUses[0]).toEqual({ name: 'read', toolUseId: 'c1', input: { p: 1 } });
  });

  it('merges same-role turns, drops a leading assistant, and keeps only the latest images', () => {
    const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } };
    const b = parse({
      messages: [
        { role: 'assistant', content: 'stray' },
        { role: 'user', content: [{ type: 'text', text: 'a' }, img] },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'x' },
        { role: 'user', content: [img] },
      ],
    });
    const h = b.conversationState.history;
    expect(h).toHaveLength(2);
    expect(h[0].userInputMessage.content).toBe('a\n\nb');
    expect(h[0].userInputMessage.images).toBeUndefined();
    const cur = b.conversationState.currentMessage.userInputMessage;
    expect(cur.images).toEqual([{ format: 'png', source: { bytes: 'AAA' } }]);
    expect(cur.content).toBe('Please proceed with the task.');
  });

  it('asks for thinking on a thinking model with an effort', () => {
    expect(kiroThinkingBudget({ reasoning_effort: 'high' }, 'claude-opus-4.5')).toBe(30_000);
    expect(kiroThinkingBudget({ reasoning_effort: 'low' }, 'claude-opus-4.5')).toBe(0);
    expect(kiroThinkingBudget({ reasoning_effort: 'high' }, 'qwen3')).toBe(0);
    const b = parse({ model: 'auto', reasoning_effort: 'medium', messages: [{ role: 'user', content: 'q' }] });
    expect(b.conversationState.currentMessage.userInputMessage.content).toMatch(/^<thinking_mode>enabled<\/thinking_mode><max_thinking_length>20000/);
  });

  it('keeps ids and names Kiro takes and hashes the rest stably', () => {
    expect(kiroToolId('call_1')).toBe('call_1');
    expect(kiroToolId('bad id!')).toBe(kiroToolId('bad id!'));
    expect(kiroToolId('bad id!')).toMatch(/^t_[A-Za-z0-9_-]{32}$/);
    expect(kiroToolName('mcp.fs/read')).toMatch(/^mcp_fs_read_[0-9a-f]{12}$/);
    expect(kiroBody({ tools: [{ type: 'function', function: { name: 'mcp.fs/read' } }] }, '').names.get(kiroToolName('mcp.fs/read'))).toBe('mcp.fs/read');
  });
});
