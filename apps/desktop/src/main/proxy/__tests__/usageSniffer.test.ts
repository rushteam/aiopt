import { describe, expect, it } from 'vitest';
import { createUsageSniffer, readResponseUsage } from '../usageSniffer';
import type { SseEvent } from '../translate/streaming';

function anthropicEvent(event: string, data: unknown): SseEvent {
  return { event, data: JSON.stringify(data) };
}
function openaiChunk(obj: unknown): SseEvent {
  return { data: JSON.stringify(obj) };
}

describe('readResponseUsage (non-streaming)', () => {
  it('reads OpenAI prompt/completion tokens', () => {
    expect(readResponseUsage('openai', { usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } })).toMatchObject({
      inputTokens: 5,
      outputTokens: 7,
    });
  });

  it('reads Anthropic input/output tokens', () => {
    expect(readResponseUsage('anthropic', { usage: { input_tokens: 3, output_tokens: 9 } })).toMatchObject({
      inputTokens: 3,
      outputTokens: 9,
    });
  });

  it('reads OpenAI Responses input/output tokens', () => {
    expect(readResponseUsage('openai-responses', { usage: { input_tokens: 11, output_tokens: 4 } })).toMatchObject({
      inputTokens: 11,
      outputTokens: 4,
    });
  });

  it('returns zeros when usage is missing or malformed', () => {
    expect(readResponseUsage('openai', {})).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(readResponseUsage('anthropic', { usage: null as unknown as Record<string, unknown> })).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(readResponseUsage('openai', { usage: { prompt_tokens: 'x' } })).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('createUsageSniffer — anthropic stream', () => {
  it('takes input from message_start and running output from message_delta', () => {
    const s = createUsageSniffer('anthropic');
    s.observe(anthropicEvent('message_start', { message: { usage: { input_tokens: 12, output_tokens: 0 } } }));
    s.observe(anthropicEvent('content_block_delta', { delta: { text: 'hi' } }));
    s.observe(anthropicEvent('message_delta', { usage: { output_tokens: 4 } }));
    s.observe(anthropicEvent('message_delta', { usage: { output_tokens: 30 } }));
    s.observe(anthropicEvent('message_stop', {}));
    expect(s.result()).toMatchObject({ inputTokens: 12, outputTokens: 30 });
  });
});

describe('createUsageSniffer — openai-responses stream', () => {
  it('reads usage nested under `response` on the terminal event', () => {
    const s = createUsageSniffer('openai-responses');
    s.observe({ event: 'response.created', data: JSON.stringify({ response: {} }) });
    s.observe({ event: 'response.output_text.delta', data: JSON.stringify({ delta: 'hi' }) });
    s.observe({
      event: 'response.completed',
      data: JSON.stringify({ response: { usage: { input_tokens: 20, output_tokens: 6 } } }),
    });
    expect(s.result()).toMatchObject({ inputTokens: 20, outputTokens: 6 });
  });

  it('stays at zero when no terminal usage arrives', () => {
    const s = createUsageSniffer('openai-responses');
    s.observe({ event: 'response.output_text.delta', data: JSON.stringify({ delta: 'hi' }) });
    expect(s.result()).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('createUsageSniffer — openai stream', () => {
  it('reads the terminal usage chunk when include_usage is on', () => {
    const s = createUsageSniffer('openai');
    s.observe(openaiChunk({ choices: [{ delta: { content: 'Hel' } }] }));
    s.observe(openaiChunk({ choices: [{ delta: { content: 'lo' } }] }));
    s.observe(openaiChunk({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }));
    s.observe({ data: '[DONE]' });
    expect(s.result()).toMatchObject({ inputTokens: 8, outputTokens: 2 });
  });

  it('stays at zero when no usage chunk is present (include_usage off)', () => {
    const s = createUsageSniffer('openai');
    s.observe(openaiChunk({ choices: [{ delta: { content: 'hi' } }] }));
    s.observe(openaiChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    s.observe({ data: '[DONE]' });
    expect(s.result()).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('ignores unparseable event data', () => {
    const s = createUsageSniffer('openai');
    s.observe({ data: 'not json' });
    s.observe({ data: undefined as unknown as string });
    expect(s.result()).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('gemini usageMetadata', () => {
  it('reads a non-streaming body, counting reasoning tokens as output', () => {
    expect(
      readResponseUsage('gemini', {
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 6 },
      }),
    ).toMatchObject({ inputTokens: 10, outputTokens: 10 });
    expect(readResponseUsage('gemini', {})).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('keeps the latest running count from a stream', () => {
    const s = createUsageSniffer('gemini');
    s.observe({ data: JSON.stringify({ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }) });
    s.observe({ data: JSON.stringify({ candidates: [] }) });
    s.observe({ data: JSON.stringify({ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 9 } }) });
    expect(s.result()).toMatchObject({ inputTokens: 3, outputTokens: 9 });
  });
});

describe('cache and reasoning tokens', () => {
  it('OpenAI Chat: cached prompt is split out of prompt_tokens; reasoning is read', () => {
    expect(
      readResponseUsage('openai', {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          prompt_tokens_details: { cached_tokens: 60 },
          completion_tokens_details: { reasoning_tokens: 25 },
        },
      }),
    ).toEqual({ inputTokens: 40, outputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 0, reasoningTokens: 25 });
  });

  it('OpenAI Chat: DeepSeek prompt_cache_hit_tokens counts as a cache read', () => {
    expect(
      readResponseUsage('openai', { usage: { prompt_tokens: 50, completion_tokens: 5, prompt_cache_hit_tokens: 30 } }),
    ).toEqual({ inputTokens: 20, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 0, reasoningTokens: 0 });
  });

  it('Anthropic: input_tokens already excludes cache read/write', () => {
    expect(
      readResponseUsage('anthropic', {
        usage: { input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 500, cache_creation_input_tokens: 80 },
      }),
    ).toEqual({ inputTokens: 7, outputTokens: 9, cacheReadTokens: 500, cacheWriteTokens: 80, reasoningTokens: 0 });
  });

  it('Anthropic stream: cache from message_start survives; message_delta updates what it carries', () => {
    const s = createUsageSniffer('anthropic');
    s.observe(
      anthropicEvent('message_start', {
        message: { usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 12 } },
      }),
    );
    s.observe(anthropicEvent('message_delta', { usage: { output_tokens: 33 } }));
    expect(s.result()).toEqual({ inputTokens: 4, outputTokens: 33, cacheReadTokens: 900, cacheWriteTokens: 12, reasoningTokens: 0 });
    s.observe(anthropicEvent('message_delta', { usage: { output_tokens: 40, cache_read_input_tokens: 950 } }));
    expect(s.result()).toMatchObject({ outputTokens: 40, cacheReadTokens: 950, cacheWriteTokens: 12 });
  });

  it('Responses: cached and reasoning details', () => {
    const s = createUsageSniffer('openai-responses');
    s.observe({
      event: 'response.completed',
      data: JSON.stringify({
        response: {
          usage: {
            input_tokens: 80,
            output_tokens: 30,
            input_tokens_details: { cached_tokens: 64 },
            output_tokens_details: { reasoning_tokens: 20 },
          },
        },
      }),
    });
    expect(s.result()).toEqual({ inputTokens: 16, outputTokens: 30, cacheReadTokens: 64, cacheWriteTokens: 0, reasoningTokens: 20 });
  });

  it('Gemini: cachedContentTokenCount and thoughtsTokenCount', () => {
    expect(
      readResponseUsage('gemini', {
        usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 70, candidatesTokenCount: 4, thoughtsTokenCount: 6 },
      }),
    ).toEqual({ inputTokens: 30, outputTokens: 10, cacheReadTokens: 70, cacheWriteTokens: 0, reasoningTokens: 6 });
  });

  it('never goes negative when a cached count exceeds the prompt count', () => {
    expect(
      readResponseUsage('openai', { usage: { prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 9 } } }),
    ).toMatchObject({ inputTokens: 0, cacheReadTokens: 9 });
  });
});
