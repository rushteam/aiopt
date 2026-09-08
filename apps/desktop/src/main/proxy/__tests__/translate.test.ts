import { describe, expect, it } from 'vitest';
import {
  requestAnthropicToOpenai,
  responseAnthropicToOpenai,
} from '../translate/anthropicToOpenai';
import {
  DEFAULT_MAX_TOKENS,
  requestOpenaiToAnthropic,
  responseOpenaiToAnthropic,
} from '../translate/openaiToAnthropic';
import type {
  AnthropicRequest,
  AnthropicResponse,
  OpenAiRequest,
  OpenAiResponse,
} from '../translate/types';

// --- Anthropic → OpenAI (the enabled direction's request leg) ---------------

describe('requestAnthropicToOpenai', () => {
  it('maps system + multi-turn text into OpenAI messages, forcing the route model', () => {
    const req: AnthropicRequest = {
      model: 'ignored-by-route',
      system: 'You are terse.',
      max_tokens: 256,
      temperature: 0.4,
      stop_sequences: ['STOP'],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'bye' },
      ],
    };
    const out = requestAnthropicToOpenai(req, 'deepseek-chat');
    expect(out.model).toBe('deepseek-chat');
    expect(out.messages[0]).toEqual({ role: 'system', content: 'You are terse.' });
    expect(out.messages.slice(1)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
    ]);
    expect(out.max_tokens).toBe(256);
    expect(out.temperature).toBe(0.4);
    expect(out.stop).toEqual(['STOP']);
  });

  it('maps tool_use / tool_result blocks and tool_choice', () => {
    const req: AnthropicRequest = {
      max_tokens: 100,
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'get_weather' },
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'SF' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '72F' }],
        },
      ],
    };
    const out = requestAnthropicToOpenai(req, 'gpt-4o');
    expect(out.tools?.[0]).toEqual({
      type: 'function',
      function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } },
    });
    expect(out.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });

    const assistant = out.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('let me check');
    expect(assistant?.tool_calls?.[0]).toEqual({
      id: 'tu_1',
      type: 'function',
      function: { name: 'get_weather', arguments: JSON.stringify({ city: 'SF' }) },
    });

    const tool = out.messages.find((m) => m.role === 'tool');
    expect(tool).toEqual({ role: 'tool', tool_call_id: 'tu_1', content: '72F' });
  });

  it('rejects an image block with UNSUPPORTED_CAPABILITY (no silent drop)', () => {
    const req: AnthropicRequest = {
      max_tokens: 10,
      messages: [{ role: 'user', content: [{ type: 'image', source: { data: 'x' } }] }],
    };
    expect(() => requestAnthropicToOpenai(req, 'gpt-4o')).toThrow(/UNSUPPORTED_CAPABILITY/);
  });

  it('rejects extended-thinking requests', () => {
    const req: AnthropicRequest = {
      max_tokens: 10,
      thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect(() => requestAnthropicToOpenai(req, 'gpt-4o')).toThrow(/UNSUPPORTED_CAPABILITY/);
  });
});

describe('responseAnthropicToOpenai', () => {
  it('maps content + usage + stop_reason', () => {
    const resp: AnthropicResponse = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text: 'answer' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 7 },
    };
    const out = responseAnthropicToOpenai(resp);
    expect(out.choices[0]?.message).toEqual({ role: 'assistant', content: 'answer' });
    expect(out.choices[0]?.finish_reason).toBe('stop');
    expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 });
  });

  it('maps tool_use blocks to tool_calls with tool_calls finish reason', () => {
    const resp: AnthropicResponse = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'tool_use', id: 'tu_9', name: 'f', input: { a: 1 } }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    const out = responseAnthropicToOpenai(resp);
    expect(out.choices[0]?.finish_reason).toBe('tool_calls');
    expect(out.choices[0]?.message.tool_calls?.[0]).toEqual({
      id: 'tu_9',
      type: 'function',
      function: { name: 'f', arguments: JSON.stringify({ a: 1 }) },
    });
    expect(out.choices[0]?.message.content).toBeNull();
  });
});

// --- OpenAI → Anthropic (reserved direction, unit-tested only) --------------

describe('requestOpenaiToAnthropic', () => {
  it('lifts system messages to the top-level system field and forces the route model', () => {
    const req: OpenAiRequest = {
      model: 'ignored',
      max_tokens: 128,
      temperature: 0.2,
      stop: 'END',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    };
    const out = requestOpenaiToAnthropic(req, 'claude-sonnet-4');
    expect(out.model).toBe('claude-sonnet-4');
    expect(out.system).toBe('be brief');
    expect(out.max_tokens).toBe(128);
    expect(out.stop_sequences).toEqual(['END']);
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('injects a default max_tokens when the OpenAI request omits it', () => {
    const req: OpenAiRequest = { messages: [{ role: 'user', content: 'hi' }] };
    const out = requestOpenaiToAnthropic(req, 'claude');
    expect(out.max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it('maps tool_calls to tool_use blocks and tool messages to tool_result', () => {
    const req: OpenAiRequest = {
      max_tokens: 64,
      tool_choice: 'required',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'w', arguments: '{"city":"SF"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '72F' },
      ],
    };
    const out = requestOpenaiToAnthropic(req, 'claude');
    expect(out.tool_choice).toEqual({ type: 'any' });

    const assistant = out.messages.find((m) => m.role === 'assistant');
    expect(Array.isArray(assistant?.content)).toBe(true);
    expect(assistant?.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'w', input: { city: 'SF' } }]);

    const user = out.messages[out.messages.length - 1];
    expect(user).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '72F' }],
    });
  });

  it('rejects unsupported request fields (response_format)', () => {
    const req: OpenAiRequest = {
      max_tokens: 8,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect(() => requestOpenaiToAnthropic(req, 'claude')).toThrow(/UNSUPPORTED_CAPABILITY/);
  });
});

describe('responseOpenaiToAnthropic', () => {
  it('maps a text completion into an Anthropic message', () => {
    const resp: OpenAiResponse = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    };
    const out = responseOpenaiToAnthropic(resp);
    expect(out.content).toEqual([{ type: 'text', text: 'hi there' }]);
    expect(out.stop_reason).toBe('end_turn');
    expect(out.usage).toEqual({ input_tokens: 3, output_tokens: 4 });
  });

  it('maps tool_calls to tool_use blocks', () => {
    const resp: OpenAiResponse = {
      id: 'chatcmpl-2',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-chat',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const out = responseOpenaiToAnthropic(resp);
    expect(out.stop_reason).toBe('tool_use');
    expect(out.content).toEqual([{ type: 'tool_use', id: 'call_2', name: 'f', input: { a: 1 } }]);
  });
});
