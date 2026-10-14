import { describe, expect, it } from 'vitest';
import {
  createGeminiToAnthropicStream,
  createGeminiToOpenaiStream,
  encodeCallId,
  requestAnthropicToGemini,
  requestOpenaiToGemini,
  responseGeminiToAnthropic,
  responseGeminiToOpenai,
  signatureFromCallId,
  toGeminiSchema,
} from '../translate/gemini';

describe('gemini call ids', () => {
  it('carries a thought signature round-trip and omits it when absent', () => {
    const id = encodeCallId('SIG==');
    expect(signatureFromCallId(id)).toBe('SIG==');
    expect(signatureFromCallId(encodeCallId(undefined))).toBeUndefined();
    expect(signatureFromCallId('toolu_123')).toBeUndefined();
  });
});

describe('toGeminiSchema', () => {
  it('keeps the supported subset and normalises the rest', () => {
    expect(
      toGeminiSchema({
        $schema: 'x',
        type: 'object',
        additionalProperties: false,
        properties: {
          a: { type: ['string', 'null'], const: 'k' },
          b: { type: 'array', items: { type: 'integer', exclusiveMinimum: 0 } },
        },
        required: ['a'],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string', nullable: true, enum: ['k'] },
        b: { type: 'array', items: { type: 'integer' } },
      },
      required: ['a'],
    });
  });
});

describe('requestAnthropicToGemini', () => {
  it('maps system, turns, tools, tool results and generation config', () => {
    const callId = encodeCallId('SIG');
    const out = requestAnthropicToGemini({
      model: 'claude',
      max_tokens: 100,
      temperature: 0.2,
      stop_sequences: ['END'],
      system: [{ type: 'text', text: 'be brief' }],
      tools: [{ name: 'read', description: 'read a file', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'tool', name: 'read' },
      messages: [
        { role: 'user', content: 'open a' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm', signature: 's' },
            { type: 'tool_use', id: callId, name: 'read', input: { path: 'a' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: 'A' }] },
      ],
    } as never);
    expect(out.systemInstruction).toEqual({ parts: [{ text: 'be brief' }] });
    expect(out.contents).toEqual([
      { role: 'user', parts: [{ text: 'open a' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read', args: { path: 'a' } }, thoughtSignature: 'SIG' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read', response: { content: 'A' } } }] },
    ]);
    expect(out.tools![0]!.functionDeclarations[0]!.name).toBe('read');
    expect(out.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read'] } });
    expect(out.generationConfig).toEqual({ maxOutputTokens: 100, temperature: 0.2, stopSequences: ['END'] });
  });

  it('refuses an unsupported block rather than dropping it', () => {
    expect(() =>
      requestAnthropicToGemini({
        model: 'c',
        max_tokens: 1,
        messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }],
      } as never),
    ).toThrow(/UNSUPPORTED_CAPABILITY|not supported/);
  });
});

describe('requestOpenaiToGemini', () => {
  it('maps system, text parts, tool calls and tool messages', () => {
    const out = requestOpenaiToGemini({
      model: 'gpt',
      max_tokens: 10,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ],
      tool_choice: 'required',
    } as never);
    expect(out.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
    expect(out.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ functionCall: { name: 'f', args: { x: 1 } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'f', response: { content: 'ok' } } }] },
    ]);
    expect(out.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
    expect(out.generationConfig).toEqual({ maxOutputTokens: 10 });
  });
});

const toolReply = {
  candidates: [
    {
      content: {
        parts: [
          { text: 'thinking…', thought: true },
          { text: 'ok' },
          { functionCall: { name: 'f', args: { a: 1 } }, thoughtSignature: 'S1' },
        ],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2 },
};

describe('non-streaming responses', () => {
  it('lifts to Anthropic, dropping thought parts and keeping the signature in the id', () => {
    const r = responseGeminiToAnthropic(toolReply, 'gm');
    expect(r.stop_reason).toBe('tool_use');
    expect(r.content[0]).toEqual({ type: 'text', text: 'ok' });
    const tool = r.content[1] as { id: string; name: string; input: unknown };
    expect(tool.name).toBe('f');
    expect(tool.input).toEqual({ a: 1 });
    expect(signatureFromCallId(tool.id)).toBe('S1');
    expect(r.usage).toEqual({ input_tokens: 7, output_tokens: 5 });
  });

  it('lifts to OpenAI Chat', () => {
    const r = responseGeminiToOpenai(toolReply, 'gm');
    expect(r.choices[0]!.finish_reason).toBe('tool_calls');
    expect(r.choices[0]!.message.content).toBe('ok');
    expect(r.choices[0]!.message.tool_calls![0]!.function).toEqual({ name: 'f', arguments: '{"a":1}' });
    expect(r.usage).toEqual({ prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 });
  });

  it('maps MAX_TOKENS and safety stops', () => {
    const cut = { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] };
    expect(responseGeminiToAnthropic(cut, 'm').stop_reason).toBe('max_tokens');
    expect(responseGeminiToOpenai(cut, 'm').choices[0]!.finish_reason).toBe('length');
    const blocked = { candidates: [{ finishReason: 'SAFETY' }] };
    expect(responseGeminiToOpenai(blocked, 'm').choices[0]!.finish_reason).toBe('content_filter');
  });
});

const ev = (obj: unknown) => ({ data: JSON.stringify(obj) });

describe('streams', () => {
  it('Gemini → Anthropic emits a well-formed event sequence', () => {
    const t = createGeminiToAnthropicStream('gm');
    const frames = [
      ...t(ev({ candidates: [{ content: { parts: [{ text: 'a' }] } }] })),
      ...t(ev({ candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: {} } }] }, finishReason: 'STOP' }] })),
      ...t.flush(),
    ].join('');
    const names = [...frames.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
    expect(names).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(frames).toContain('"stop_reason":"tool_use"');
  });

  it('Gemini → OpenAI ends with usage and [DONE] on flush', () => {
    const t = createGeminiToOpenaiStream('gm');
    const frames = [
      ...t(ev({ candidates: [{ content: { parts: [{ text: 'a' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })),
      ...t.flush(),
      ...t.flush(),
    ].join('');
    expect(frames).toContain('"content":"a"');
    expect(frames).toContain('"finish_reason":"stop"');
    expect(frames).toContain('"total_tokens":2');
    expect(frames.match(/\[DONE\]/g)).toHaveLength(1);
  });
});
