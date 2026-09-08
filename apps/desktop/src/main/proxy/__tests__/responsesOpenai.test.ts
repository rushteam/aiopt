import { describe, expect, it } from 'vitest';
import {
  createOpenaiToResponsesStream,
  requestResponsesToOpenai,
  responseOpenaiToResponses,
} from '../translate/responsesOpenai';
import { SseDecoder, type SseEvent } from '../translate/streaming';
import type { OpenAiResponse, ResponsesRequest } from '../translate/types';

function decodeFrames(frames: string[]): SseEvent[] {
  const dec = new SseDecoder();
  const events: SseEvent[] = [];
  for (const f of frames) events.push(...dec.push(f));
  events.push(...dec.flush());
  return events;
}
function openaiChunk(obj: unknown): SseEvent {
  return { data: JSON.stringify(obj) };
}

// --- Responses → OpenAI Chat (request leg) ----------------------------------

describe('requestResponsesToOpenai', () => {
  it('maps instructions → system, a bare-string input → one user message, forcing the route model', () => {
    const req: ResponsesRequest = {
      model: 'ignored-by-route',
      instructions: 'You are terse.',
      input: 'hi',
      max_output_tokens: 256,
      temperature: 0.4,
    };
    const out = requestResponsesToOpenai(req, 'deepseek-chat');
    expect(out.model).toBe('deepseek-chat');
    expect(out.messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
    ]);
    expect(out.max_tokens).toBe(256);
    expect(out.temperature).toBe(0.4);
  });

  it('maps message items (input_text/output_text parts, developer→system) across roles', () => {
    const req: ResponsesRequest = {
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys rules' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      ],
    };
    const out = requestResponsesToOpenai(req, 'gpt-4o');
    expect(out.messages).toEqual([
      { role: 'system', content: 'sys rules' },
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ]);
  });

  it('coalesces a function_call onto the preceding assistant turn; maps function_call_output → tool message', () => {
    const req: ResponsesRequest = {
      input: [
        { type: 'message', role: 'user', content: 'weather?' },
        { type: 'message', role: 'assistant', content: 'let me check' },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '72F' },
      ],
    };
    const out = requestResponsesToOpenai(req, 'gpt-4o');
    const assistant = out.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('let me check');
    expect(assistant?.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
    ]);
    expect(out.messages[out.messages.length - 1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '72F',
    });
  });

  it('opens a fresh assistant message for a function_call with no preceding assistant turn', () => {
    const req: ResponsesRequest = {
      input: [
        { type: 'message', role: 'user', content: 'go' },
        { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      ],
    };
    const out = requestResponsesToOpenai(req, 'm');
    const last = out.messages[out.messages.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.content).toBeNull();
    expect(last.tool_calls?.[0]?.id).toBe('c1');
  });

  it('drops reasoning items and maps top-level reasoning.effort best-effort', () => {
    const req: ResponsesRequest = {
      reasoning: { effort: 'high' },
      input: [
        { type: 'reasoning', encrypted_content: 'ignored-on-chat' },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    };
    const out = requestResponsesToOpenai(req, 'm');
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(out.reasoning_effort).toBe('high');
    expect(JSON.stringify(out)).not.toContain('ignored-on-chat');
  });

  it('maps flat Responses tools + tool_choice to Chat function tools', () => {
    const req: ResponsesRequest = {
      input: 'hi',
      tools: [{ type: 'function', name: 'get_weather', description: 'w', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'get_weather' },
    };
    const out = requestResponsesToOpenai(req, 'm');
    expect(out.tools?.[0]).toEqual({
      type: 'function',
      function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } },
    });
    expect(out.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('rejects previous_response_id, built-in tools, and image parts (no silent drop)', () => {
    expect(() =>
      requestResponsesToOpenai({ input: 'hi', previous_response_id: 'resp_x' }, 'm'),
    ).toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(() =>
      requestResponsesToOpenai({ input: 'hi', tools: [{ type: 'web_search' }] }, 'm'),
    ).toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(() =>
      requestResponsesToOpenai(
        { input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }] },
        'm',
      ),
    ).toThrow(/UNSUPPORTED_CAPABILITY/);
  });
});

// --- OpenAI Chat → Responses (non-streaming response leg) -------------------

describe('responseOpenaiToResponses', () => {
  it('lifts a text completion into a Responses message item with completed status', () => {
    const resp: OpenAiResponse = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 100,
      model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    };
    const out = responseOpenaiToResponses(resp);
    expect(out.object).toBe('response');
    expect(out.status).toBe('completed');
    expect(out.output).toEqual([
      {
        type: 'message',
        id: expect.stringMatching(/^msg_/),
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hello', annotations: [] }],
      },
    ]);
    expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 7, total_tokens: 12 });
  });

  it('maps tool_calls to function_call items', () => {
    const resp: OpenAiResponse = {
      id: 'chatcmpl-2',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
    const out = responseOpenaiToResponses(resp);
    expect(out.status).toBe('completed');
    expect(out.output[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_9',
      name: 'f',
      arguments: '{"a":1}',
      status: 'completed',
    });
  });

  it('marks a length-truncated reply incomplete with max_output_tokens', () => {
    const resp: OpenAiResponse = {
      id: 'c3',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const out = responseOpenaiToResponses(resp);
    expect(out.status).toBe('incomplete');
    expect(out.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });
});

// --- OpenAI Chat stream → Responses events ----------------------------------

describe('createOpenaiToResponsesStream — text', () => {
  it('emits the created → item/part added → text deltas → done → completed sequence', () => {
    const xform = createOpenaiToResponsesStream();
    const frames: string[] = [];
    frames.push(...xform(openaiChunk({ model: 'deepseek-chat', choices: [{ delta: { role: 'assistant', content: '' } }] })));
    frames.push(...xform(openaiChunk({ choices: [{ delta: { content: 'Hello' } }] })));
    frames.push(...xform(openaiChunk({ choices: [{ delta: { content: ' world' } }] })));
    frames.push(...xform(openaiChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })));
    frames.push(...xform({ data: '[DONE]' }));

    const events = decodeFrames(frames);
    expect(events.map((e) => e.event)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);

    const text = events
      .filter((e) => e.event === 'response.output_text.delta')
      .map((e) => JSON.parse(e.data).delta)
      .join('');
    expect(text).toBe('Hello world');

    const completed = JSON.parse(events.find((e) => e.event === 'response.completed')!.data);
    expect(completed.response.status).toBe('completed');
    expect(completed.response.output[0].content[0].text).toBe('Hello world');
  });
});

describe('createOpenaiToResponsesStream — tool calls', () => {
  it('emits function_call_arguments deltas spanning chunks and a completed envelope', () => {
    const xform = createOpenaiToResponsesStream();
    const frames: string[] = [];
    frames.push(...xform(openaiChunk({ model: 'm', choices: [{ delta: { role: 'assistant' } }] })));
    frames.push(
      ...xform(
        openaiChunk({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }],
        }),
      ),
    );
    frames.push(...xform(openaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }] })));
    frames.push(...xform(openaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"SF"}' } }] } }] })));
    frames.push(...xform(openaiChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })));

    const events = decodeFrames(frames);
    expect(events.map((e) => e.event)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);

    const added = JSON.parse(events[1]!.data);
    expect(added.item).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'get_weather' });

    const args = events
      .filter((e) => e.event === 'response.function_call_arguments.delta')
      .map((e) => JSON.parse(e.data).delta)
      .join('');
    expect(args).toBe('{"city":"SF"}');

    const done = JSON.parse(events.find((e) => e.event === 'response.function_call_arguments.done')!.data);
    expect(done.arguments).toBe('{"city":"SF"}');
  });
});
