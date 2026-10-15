import { describe, expect, it } from 'vitest';
import type { UpstreamEvent } from '../types';
import { clientMessage, collectCompletion, createChunkMapper } from '../openaiChatOut';

const ident = { id: 'chatcmpl-1', created: 1, model: 'auto' };
const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };

async function* events(...es: UpstreamEvent[]): AsyncGenerator<UpstreamEvent> {
  for (const e of es) yield e;
}

describe('driver events → OpenAI chunks', () => {
  it('opens with the role, maps deltas and ends with [DONE]', () => {
    const m = createChunkMapper(ident);
    const out = [
      ...m.map({ text: 'Hi' }),
      ...m.map({ tool: { index: 0, id: 'c', name: 'read', args: '{}' } }),
      ...m.map({ stop: 'tool_calls', usage }),
      ...m.done(),
    ];
    const data = out.map((e) => e.data);
    expect(data.at(-1)).toBe('[DONE]');
    const chunks = data.slice(0, -1).map((d) => JSON.parse(d) as { choices: Array<{ delta: unknown; finish_reason: unknown }>; usage?: unknown });
    expect(chunks[0]!.choices[0]!.delta).toEqual({ role: 'assistant', content: '' });
    expect(chunks[1]!.choices[0]!.delta).toEqual({ content: 'Hi' });
    expect(chunks[2]!.choices[0]!.delta).toMatchObject({ tool_calls: [{ id: 'c', function: { name: 'read' } }] });
    expect(chunks[3]!.choices[0]!.finish_reason).toBe('tool_calls');
    expect(chunks[3]!.usage).toEqual(usage);
  });
});

describe('driver events → OpenAI completion', () => {
  it('collects text, reasoning, tool calls and usage', async () => {
    const out = await collectCompletion(
      events({ reasoning: 'r' }, { text: 'a' }, { text: 'b' }, { tool: { index: 0, id: 'c', name: 'x', args: '{}' } }, { stop: 'tool_calls', usage }),
      ident,
    );
    expect('completion' in out && out.completion).toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { content: 'ab', reasoning_content: 'r', tool_calls: [{ id: 'c' }] }, finish_reason: 'tool_calls' }],
      usage,
    });
  });

  it('surfaces a failure and keeps Cursor text out of the client message', async () => {
    const out = await collectCompletion(events({ error: { status: 429, message: 'secret detail' } }), ident);
    expect(out).toEqual({ error: { status: 429, message: 'secret detail' } });
    expect(clientMessage(429)).not.toContain('secret');
  });
});
