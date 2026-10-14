import { describe, expect, it } from 'vitest';
import { hasCacheControl, injectPromptCache, MAX_CACHE_BREAKPOINTS } from '../promptCache';

const mark = { type: 'ephemeral' };

function count(value: unknown): number {
  return JSON.stringify(value).split('"cache_control"').length - 1;
}

describe('injectPromptCache', () => {
  it('marks the last tool, the system prompt and the final two user turns', () => {
    const body = {
      model: 'm',
      tools: [{ name: 'a', input_schema: {} }, { name: 'b', input_schema: {} }],
      system: 'sys',
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: [{ type: 'text', text: 'two' }] },
        { role: 'assistant', content: 'r2' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] },
      ],
    };
    const { body: out, added } = injectPromptCache(body);
    expect(added).toBe(4);
    expect(count(out)).toBe(MAX_CACHE_BREAKPOINTS);
    const tools = out.tools as Record<string, unknown>[];
    expect(tools[0]).not.toHaveProperty('cache_control');
    expect(tools[1]!.cache_control).toEqual(mark);
    expect(out.system).toEqual([{ type: 'text', text: 'sys', cache_control: mark }]);
    const messages = out.messages as { content: unknown }[];
    expect(messages[0]!.content).toBe('one');
    expect(messages[2]!.content).toEqual([{ type: 'text', text: 'two', cache_control: mark }]);
    expect(messages[4]!.content).toEqual([{ type: 'tool_result', tool_use_id: 't', content: 'x', cache_control: mark }]);
  });

  it('does not mutate the input', () => {
    const body = { system: 'sys', messages: [{ role: 'user', content: 'hi' }] };
    const snapshot = JSON.stringify(body);
    injectPromptCache(body);
    expect(JSON.stringify(body)).toBe(snapshot);
  });

  it('leaves a body that already has breakpoints unchanged', () => {
    const body = {
      system: [{ type: 'text', text: 's', cache_control: mark }],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const result = injectPromptCache(body);
    expect(result.added).toBe(0);
    expect(result.body).toBe(body);
  });

  it('skips thinking and empty text blocks', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'keep' },
            { type: 'text', text: '' },
          ],
        },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
      ],
    };
    const { body: out, added } = injectPromptCache(body);
    expect(added).toBe(1);
    const content = (out.messages as { content: Record<string, unknown>[] }[])[0]!.content;
    expect(content[0]!.cache_control).toEqual(mark);
    expect(content[1]).not.toHaveProperty('cache_control');
  });

  it('returns the same object when nothing qualifies', () => {
    const body = { messages: [{ role: 'user', content: '' }] };
    const result = injectPromptCache(body);
    expect(result).toEqual({ body, added: 0 });
    expect(result.body).toBe(body);
  });
});

describe('hasCacheControl', () => {
  it('finds a nested marker', () => {
    expect(hasCacheControl({ messages: [{ content: [{ cache_control: mark }] }] })).toBe(true);
    expect(hasCacheControl({ messages: [{ content: 'x' }] })).toBe(false);
  });
});
