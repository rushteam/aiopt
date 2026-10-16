import { describe, expect, it } from 'vitest';
import { readChatSse, usageFrom } from '../openaiChatIn';
import type { UpstreamEvent } from '../types';

function body(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      // split mid-frame to exercise buffering
      c.enqueue(bytes.slice(0, 17));
      c.enqueue(bytes.slice(17));
      c.close();
    },
  });
}

async function all(it: AsyncIterable<UpstreamEvent>): Promise<UpstreamEvent[]> {
  const out: UpstreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const frame = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;

describe('readChatSse', () => {
  it('reads text, reasoning, gathered tool calls and usage', async () => {
    const sse =
      frame({ choices: [{ delta: { reasoning_content: 'think' } }] }) +
      frame({ choices: [{ delta: { content: 'Hi' } }] }) +
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a"' } }] } }] }) +
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] }) +
      frame({
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 6 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      }) +
      'data: [DONE]\n\n';
    expect(await all(readChatSse(body(sse)))).toEqual([
      { reasoning: 'think' },
      { text: 'Hi' },
      { tool: { index: 0, id: 'c1', name: 'f', args: '{"a":1}' } },
      {
        stop: 'tool_calls',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          prompt_tokens_details: { cached_tokens: 6 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      },
    ]);
  });

  it('ends without [DONE] and reports an in-stream error', async () => {
    expect(await all(readChatSse(body(frame({ choices: [{ delta: { content: 'x' } }] }))))).toEqual([
      { text: 'x' },
      { stop: 'stop', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
    ]);
    const out = await all(readChatSse(body(frame({ error: { message: 'secret echo' } }))));
    expect(out).toEqual([{ error: { status: 502, message: 'stream error' } }]);
  });

  it('maps DeepSeek-style cache hits', () => {
    expect(usageFrom({ prompt_tokens: 5, completion_tokens: 1, prompt_cache_hit_tokens: 3 }).prompt_tokens_details).toEqual({
      cached_tokens: 3,
    });
  });
});
