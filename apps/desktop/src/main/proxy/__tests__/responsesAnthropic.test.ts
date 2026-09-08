import { describe, expect, it } from 'vitest';
import {
  createAnthropicToResponsesStream,
  decodeReasoning,
  encodeReasoning,
  requestResponsesToAnthropic,
  responseAnthropicToResponses,
} from '../translate/responsesAnthropic';
import { SseDecoder, type SseEvent } from '../translate/streaming';
import type { AnthropicResponse, ResponsesRequest } from '../translate/types';

function decodeFrames(frames: string[]): SseEvent[] {
  const dec = new SseDecoder();
  const events: SseEvent[] = [];
  for (const f of frames) events.push(...dec.push(f));
  events.push(...dec.flush());
  return events;
}
function anthropicEvent(event: string, data: unknown): SseEvent {
  return { event, data: JSON.stringify(data) };
}

// --- reasoning bridge (the core Anthropic-pair invariant) -------------------

describe('encodeReasoning / decodeReasoning', () => {
  it('round-trips thinking + signature byte-for-byte through the opaque field', () => {
    const payload = {
      thinking: 'Let me reason:\n1) x\n2) 中文 & symbols « » 🤔',
      signature: 'ErcBCkgIARABGAIiQJ/dummy+SIG==/with/slashes+and+plus',
    };
    const encoded = encodeReasoning(payload);
    // Opaque token, not the plaintext.
    expect(encoded).not.toContain('Let me reason');
    expect(encoded).not.toContain('dummy+SIG');
    const decoded = decodeReasoning(encoded);
    expect(decoded).toEqual(payload);
    expect(decoded?.signature).toBe(payload.signature);
  });

  it('returns null for malformed / missing input rather than throwing', () => {
    expect(decodeReasoning(undefined)).toBeNull();
    expect(decodeReasoning(null)).toBeNull();
    expect(decodeReasoning('')).toBeNull();
    expect(decodeReasoning('not-base64-@@@')).toBeNull();
    // valid base64 but wrong shape
    expect(decodeReasoning(Buffer.from('{"foo":1}', 'utf8').toString('base64'))).toBeNull();
  });
});

// --- Responses → Anthropic (request leg) ------------------------------------

describe('requestResponsesToAnthropic', () => {
  it('maps instructions → system, bare-string input → user message, max_output_tokens → max_tokens', () => {
    const req: ResponsesRequest = {
      instructions: 'You are terse.',
      input: 'hi',
      max_output_tokens: 512,
      temperature: 0.3,
    };
    const out = requestResponsesToAnthropic(req, 'claude-sonnet-4');
    expect(out.model).toBe('claude-sonnet-4');
    expect(out.system).toBe('You are terse.');
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(out.max_tokens).toBe(512);
    expect(out.temperature).toBe(0.3);
  });

  it('defaults max_tokens when absent and folds developer/system parts into system', () => {
    const req: ResponsesRequest = {
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rule A' }] },
        { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'rule B' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      ],
    };
    const out = requestResponsesToAnthropic(req, 'm');
    expect(out.max_tokens).toBe(4096);
    expect(out.system).toBe('rule A\n\nrule B');
    expect(out.messages).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('assembles reasoning + function_call into one assistant turn with thinking first', () => {
    const bridge = encodeReasoning({ thinking: 'plan the call', signature: 'sig-123' });
    const req: ResponsesRequest = {
      input: [
        { type: 'message', role: 'user', content: 'weather?' },
        { type: 'reasoning', encrypted_content: bridge },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '72F' },
        { type: 'message', role: 'user', content: 'thanks' },
      ],
    };
    const out = requestResponsesToAnthropic(req, 'm');
    expect(out.messages).toEqual([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan the call', signature: 'sig-123' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SF' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '72F' }] },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('skips a reasoning item whose bridge payload is corrupt (degrades, no throw)', () => {
    const req: ResponsesRequest = {
      input: [
        { type: 'reasoning', encrypted_content: 'garbage!!!' },
        { type: 'message', role: 'assistant', content: 'ok' },
      ],
    };
    const out = requestResponsesToAnthropic(req, 'm');
    expect(out.messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }]);
  });

  it('maps top-level reasoning.effort to extended thinking and drops temperature/top_p', () => {
    const req: ResponsesRequest = {
      input: 'hi',
      reasoning: { effort: 'low' },
      temperature: 0.9,
      top_p: 0.5,
    };
    const out = requestResponsesToAnthropic(req, 'm');
    expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
  });

  it('bumps max_tokens when the thinking budget would not fit', () => {
    const req: ResponsesRequest = { input: 'hi', reasoning: { effort: 'high' }, max_output_tokens: 2048 };
    const out = requestResponsesToAnthropic(req, 'm');
    // high budget (16384) ≥ max_tokens (2048) → bump, then budget clamps below it.
    expect(out.max_tokens).toBeGreaterThan(16384);
    expect(out.thinking).toBeTruthy();
    const budget = (out.thinking as { budget_tokens: number }).budget_tokens;
    expect(budget).toBeLessThan(out.max_tokens as number);
    expect(budget).toBeGreaterThanOrEqual(1024);
  });

  it('maps flat tools + tool_choice to the Anthropic shape', () => {
    const req: ResponsesRequest = {
      input: 'hi',
      tools: [{ type: 'function', name: 'get_weather', description: 'w', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'get_weather' },
    };
    const out = requestResponsesToAnthropic(req, 'm');
    expect(out.tools?.[0]).toEqual({ name: 'get_weather', description: 'w', input_schema: { type: 'object' } });
    expect(out.tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
  });

  it('maps tool_choice auto/required to Anthropic auto/any', () => {
    expect(requestResponsesToAnthropic({ input: 'x', tool_choice: 'auto' }, 'm').tool_choice).toEqual({ type: 'auto' });
    expect(requestResponsesToAnthropic({ input: 'x', tool_choice: 'required' }, 'm').tool_choice).toEqual({ type: 'any' });
    expect(requestResponsesToAnthropic({ input: 'x', tool_choice: 'none' }, 'm').tool_choice).toBeUndefined();
  });

  it('rejects previous_response_id, built-in tools, and image parts', () => {
    expect(() => requestResponsesToAnthropic({ input: 'hi', previous_response_id: 'resp_x' }, 'm')).toThrow(
      /UNSUPPORTED_CAPABILITY/,
    );
    expect(() => requestResponsesToAnthropic({ input: 'hi', tools: [{ type: 'web_search' }] }, 'm')).toThrow(
      /UNSUPPORTED_CAPABILITY/,
    );
    expect(() =>
      requestResponsesToAnthropic(
        { input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }] },
        'm',
      ),
    ).toThrow(/UNSUPPORTED_CAPABILITY/);
  });
});

// --- Anthropic → Responses (non-streaming response leg) ---------------------

describe('responseAnthropicToResponses', () => {
  it('lifts text + thinking + tool_use, emitting reasoning before the message', () => {
    const resp: AnthropicResponse = {
      id: 'msg_abc',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4',
      content: [
        { type: 'thinking', thinking: 'because', signature: 'SIG' } as never,
        { type: 'text', text: 'the answer' },
        { type: 'tool_use', id: 'tu_1', name: 'f', input: { a: 1 } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    const out = responseAnthropicToResponses(resp);
    expect(out.object).toBe('response');
    expect(out.status).toBe('completed');
    expect(out.id).toBe('resp_msg_abc');
    // order: reasoning, message, function_call
    expect(out.output[0]?.type).toBe('reasoning');
    expect(out.output[1]).toMatchObject({ type: 'message', content: [{ type: 'output_text', text: 'the answer' }] });
    expect(out.output[2]).toMatchObject({ type: 'function_call', call_id: 'tu_1', name: 'f', arguments: '{"a":1}' });
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 20, total_tokens: 30 });

    // The reasoning item carries the bridge — round-trips back to the source thinking.
    const reasoning = out.output[0] as { encrypted_content?: string };
    expect(decodeReasoning(reasoning.encrypted_content)).toEqual({ thinking: 'because', signature: 'SIG' });
  });

  it('marks a max_tokens stop as incomplete', () => {
    const resp: AnthropicResponse = {
      id: 'm1',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [{ type: 'text', text: 'partial' }],
      stop_reason: 'max_tokens',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const out = responseAnthropicToResponses(resp);
    expect(out.status).toBe('incomplete');
    expect(out.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });
});

// --- Anthropic stream → Responses events ------------------------------------

describe('createAnthropicToResponsesStream — text', () => {
  it('emits created → item/part added → text deltas → done → completed', () => {
    const xform = createAnthropicToResponsesStream();
    const frames: string[] = [];
    frames.push(...xform(anthropicEvent('message_start', { message: { model: 'claude-x', usage: { input_tokens: 4 } } })));
    frames.push(...xform(anthropicEvent('content_block_start', { index: 0, content_block: { type: 'text' } })));
    frames.push(...xform(anthropicEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } })));
    frames.push(...xform(anthropicEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo' } })));
    frames.push(...xform(anthropicEvent('content_block_stop', { index: 0 })));
    frames.push(...xform(anthropicEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } })));
    frames.push(...xform(anthropicEvent('message_stop', {})));

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
    expect(text).toBe('Hello');
    const completed = JSON.parse(events.find((e) => e.event === 'response.completed')!.data);
    expect(completed.response.status).toBe('completed');
    expect(completed.response.usage).toEqual({ input_tokens: 4, output_tokens: 9, total_tokens: 13 });
  });
});

describe('createAnthropicToResponsesStream — thinking bridge', () => {
  it('buffers thinking/signature deltas and emits one reasoning item carrying the bridge', () => {
    const xform = createAnthropicToResponsesStream();
    const frames: string[] = [];
    frames.push(...xform(anthropicEvent('message_start', { message: { model: 'claude-x' } })));
    frames.push(...xform(anthropicEvent('content_block_start', { index: 0, content_block: { type: 'thinking' } })));
    frames.push(...xform(anthropicEvent('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'step ' } })));
    frames.push(...xform(anthropicEvent('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'one' } })));
    frames.push(...xform(anthropicEvent('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'SIG-XYZ' } })));
    frames.push(...xform(anthropicEvent('content_block_stop', { index: 0 })));
    frames.push(...xform(anthropicEvent('content_block_start', { index: 1, content_block: { type: 'text' } })));
    frames.push(...xform(anthropicEvent('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'done' } })));
    frames.push(...xform(anthropicEvent('content_block_stop', { index: 1 })));
    frames.push(...xform(anthropicEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })));
    frames.push(...xform(anthropicEvent('message_stop', {})));

    const events = decodeFrames(frames);
    // reasoning item's added comes before its done; the bridge lands in output_item.done.
    const reasoningDone = events.find(
      (e) => e.event === 'response.output_item.done' && JSON.parse(e.data).item.type === 'reasoning',
    );
    expect(reasoningDone).toBeTruthy();
    const item = JSON.parse(reasoningDone!.data).item;
    expect(decodeReasoning(item.encrypted_content)).toEqual({ thinking: 'step one', signature: 'SIG-XYZ' });

    // No raw thinking text or signature leaks onto the wire.
    const wire = frames.join('');
    expect(wire).not.toContain('step one');
    expect(wire).not.toContain('SIG-XYZ');

    // Final completed envelope carries both the reasoning item and the message, in order.
    const completed = JSON.parse(events.find((e) => e.event === 'response.completed')!.data);
    expect(completed.response.output.map((o: { type: string }) => o.type)).toEqual(['reasoning', 'message']);
  });
});

describe('createAnthropicToResponsesStream — tool calls', () => {
  it('emits function_call args deltas across chunks and a completed envelope', () => {
    const xform = createAnthropicToResponsesStream();
    const frames: string[] = [];
    frames.push(...xform(anthropicEvent('message_start', { message: { model: 'm' } })));
    frames.push(
      ...xform(anthropicEvent('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'get_weather' } })),
    );
    frames.push(...xform(anthropicEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"ci' } })));
    frames.push(...xform(anthropicEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'ty":"SF"}' } })));
    frames.push(...xform(anthropicEvent('content_block_stop', { index: 0 })));
    frames.push(...xform(anthropicEvent('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })));
    frames.push(...xform(anthropicEvent('message_stop', {})));

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
    expect(added.item).toMatchObject({ type: 'function_call', call_id: 'tu_1', name: 'get_weather' });
    const args = events
      .filter((e) => e.event === 'response.function_call_arguments.delta')
      .map((e) => JSON.parse(e.data).delta)
      .join('');
    expect(args).toBe('{"city":"SF"}');
    const done = JSON.parse(events.find((e) => e.event === 'response.function_call_arguments.done')!.data);
    expect(done.arguments).toBe('{"city":"SF"}');
  });
});
