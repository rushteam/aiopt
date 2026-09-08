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
    expect(readResponseUsage('openai', { usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } })).toEqual({
      inputTokens: 5,
      outputTokens: 7,
    });
  });

  it('reads Anthropic input/output tokens', () => {
    expect(readResponseUsage('anthropic', { usage: { input_tokens: 3, output_tokens: 9 } })).toEqual({
      inputTokens: 3,
      outputTokens: 9,
    });
  });

  it('returns zeros when usage is missing or malformed', () => {
    expect(readResponseUsage('openai', {})).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(readResponseUsage('anthropic', { usage: null as unknown as Record<string, unknown> })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(readResponseUsage('openai', { usage: { prompt_tokens: 'x' } })).toEqual({ inputTokens: 0, outputTokens: 0 });
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
    expect(s.result()).toEqual({ inputTokens: 12, outputTokens: 30 });
  });
});

describe('createUsageSniffer — openai stream', () => {
  it('reads the terminal usage chunk when include_usage is on', () => {
    const s = createUsageSniffer('openai');
    s.observe(openaiChunk({ choices: [{ delta: { content: 'Hel' } }] }));
    s.observe(openaiChunk({ choices: [{ delta: { content: 'lo' } }] }));
    s.observe(openaiChunk({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }));
    s.observe({ data: '[DONE]' });
    expect(s.result()).toEqual({ inputTokens: 8, outputTokens: 2 });
  });

  it('stays at zero when no usage chunk is present (include_usage off)', () => {
    const s = createUsageSniffer('openai');
    s.observe(openaiChunk({ choices: [{ delta: { content: 'hi' } }] }));
    s.observe(openaiChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    s.observe({ data: '[DONE]' });
    expect(s.result()).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('ignores unparseable event data', () => {
    const s = createUsageSniffer('openai');
    s.observe({ data: 'not json' });
    s.observe({ data: undefined as unknown as string });
    expect(s.result()).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
