import { describe, expect, it } from 'vitest';
import { SseDecoder, type SseEvent } from '../translate/streaming';
import { createOpenaiToAnthropicStream } from '../translate/openaiToAnthropic';
import { createAnthropicToOpenaiStream } from '../translate/anthropicToOpenai';

/** Decode a list of emitted SSE frame strings back into structured events. */
function decodeFrames(frames: string[]): SseEvent[] {
  const dec = new SseDecoder();
  const events: SseEvent[] = [];
  for (const f of frames) events.push(...dec.push(f));
  events.push(...dec.flush());
  return events;
}

/** An OpenAI chunk frame (no event name), as the proxy would decode from upstream. */
function openaiChunk(obj: unknown): SseEvent {
  return { data: JSON.stringify(obj) };
}

describe('SseDecoder', () => {
  it('splits complete events on blank lines and buffers partial ones', () => {
    const dec = new SseDecoder();
    expect(dec.push('event: message_start\ndata: {"a":1}\n\n')).toEqual([
      { event: 'message_start', data: '{"a":1}' },
    ]);
    // Partial event withheld until its terminator arrives.
    expect(dec.push('data: {"b":')).toEqual([]);
    expect(dec.push('2}\n\n')).toEqual([{ event: undefined, data: '{"b":2}' }]);
  });

  it('ignores comment lines and strips one leading space after the colon', () => {
    const dec = new SseDecoder();
    expect(dec.push(': keep-alive\ndata: hi\n\n')).toEqual([{ event: undefined, data: 'hi' }]);
  });
});

describe('createOpenaiToAnthropicStream — text', () => {
  it('emits the full Anthropic envelope for a plain text stream', () => {
    const xform = createOpenaiToAnthropicStream();
    const frames: string[] = [];
    frames.push(...xform(openaiChunk({ model: 'deepseek-chat', choices: [{ delta: { role: 'assistant', content: '' } }] })));
    frames.push(...xform(openaiChunk({ choices: [{ delta: { content: 'Hello' } }] })));
    frames.push(...xform(openaiChunk({ choices: [{ delta: { content: ' world' } }] })));
    frames.push(...xform(openaiChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })));
    frames.push(...xform({ data: '[DONE]' }));

    const events = decodeFrames(frames);
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const text = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => JSON.parse(e.data).delta.text)
      .join('');
    expect(text).toBe('Hello world');

    const msgDelta = JSON.parse(events.find((e) => e.event === 'message_delta')!.data);
    expect(msgDelta.delta.stop_reason).toBe('end_turn');
  });
});

describe('createOpenaiToAnthropicStream — tool calls', () => {
  it('emits a tool_use block with input_json_delta fragments spanning chunks', () => {
    const xform = createOpenaiToAnthropicStream();
    const frames: string[] = [];
    frames.push(...xform(openaiChunk({ model: 'x', choices: [{ delta: { role: 'assistant' } }] })));
    frames.push(
      ...xform(
        openaiChunk({
          choices: [
            { delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] } },
          ],
        }),
      ),
    );
    frames.push(...xform(openaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }] })));
    frames.push(...xform(openaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"SF"}' } }] } }] })));
    frames.push(...xform(openaiChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })));

    const events = decodeFrames(frames);
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const start = JSON.parse(events[1]!.data);
    expect(start.content_block).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'get_weather' });

    const partial = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => JSON.parse(e.data).delta.partial_json)
      .join('');
    expect(partial).toBe('{"city":"SF"}');

    const msgDelta = JSON.parse(events.find((e) => e.event === 'message_delta')!.data);
    expect(msgDelta.delta.stop_reason).toBe('tool_use');
  });
});

describe('createAnthropicToOpenaiStream — text (reserved direction)', () => {
  it('emits OpenAI chunks terminated by [DONE]', () => {
    const xform = createAnthropicToOpenaiStream();
    const anthropicEvents: SseEvent[] = [
      { event: 'message_start', data: JSON.stringify({ message: { model: 'claude' } }) },
      { event: 'content_block_start', data: JSON.stringify({ index: 0, content_block: { type: 'text', text: '' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ index: 0, delta: { type: 'text_delta', text: 'Hi' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ index: 0 }) },
      { event: 'message_delta', data: JSON.stringify({ delta: { stop_reason: 'end_turn' } }) },
      { event: 'message_stop', data: JSON.stringify({}) },
    ];
    const frames: string[] = [];
    for (const e of anthropicEvents) frames.push(...xform(e));

    const events = decodeFrames(frames);
    const datas = events.map((e) => e.data);
    expect(datas[datas.length - 1]).toBe('[DONE]');

    const parsed = datas.filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));
    // First chunk carries the assistant role; the text delta carries content.
    expect(parsed[0].choices[0].delta).toMatchObject({ role: 'assistant' });
    const content = parsed.map((p) => p.choices[0].delta.content ?? '').join('');
    expect(content).toBe('Hi');
    const finish = parsed.find((p) => p.choices[0].finish_reason);
    expect(finish.choices[0].finish_reason).toBe('stop');
  });
});
