// Anthropic Messages → OpenAI Chat Completions transforms (pure).
//
// This direction is used for:
//   - the ENABLED route's REQUEST leg  (claude speaks Anthropic → OpenAI provider), and
//   - the reserved route's RESPONSE leg (Anthropic provider → an OpenAI-speaking client).
//
// See openaiToAnthropic.ts for the mirror image. Both are pure: no I/O, no Electron.

import { randomUUID } from 'node:crypto';
import type { SseEvent } from './streaming';
import { openAiFrame } from './streaming';
import {
  assertNoUnsupportedRequestFields,
  rejectUnsupported,
  stopReasonToFinishReason,
  type AnthropicContentBlock,
  type AnthropicToolResultBlock,
  type AnthropicRequest,
  type AnthropicResponse,
  type OpenAiMessage,
  type OpenAiRequest,
  type OpenAiResponse,
  type OpenAiToolCall,
} from './types';

/** Concatenate the text of a block array (used for `system` and tool_result content). */
function textOfBlocks(blocks: AnthropicContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('');
}

/** Anthropic tool_result content → an OpenAI tool-message string. */
function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return textOfBlocks(content as AnthropicContentBlock[]);
  return JSON.stringify(content ?? '');
}

/** Guard blocks we cannot translate (image, thinking, …) rather than dropping them silently. */
function assertTranslatableBlock(block: AnthropicContentBlock): void {
  if (block.type !== 'text' && block.type !== 'tool_use' && block.type !== 'tool_result') {
    rejectUnsupported(`Anthropic content block "${block.type}" is not supported by the translation proxy`);
  }
}

/** Translate an Anthropic Messages request body into an OpenAI Chat Completions body. */
export function requestAnthropicToOpenai(req: AnthropicRequest, modelId: string): OpenAiRequest {
  assertNoUnsupportedRequestFields(req);

  const messages: OpenAiMessage[] = [];

  if (req.system !== undefined) {
    const systemText = typeof req.system === 'string' ? req.system : textOfBlocks(req.system);
    if (systemText !== '') messages.push({ role: 'system', content: systemText });
  }

  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    for (const block of msg.content) assertTranslatableBlock(block);

    if (msg.role === 'assistant') {
      const text = textOfBlocks(msg.content);
      const toolCalls: OpenAiToolCall[] = msg.content
        .filter((b): b is Extract<AnthropicContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const out: OpenAiMessage = { role: 'assistant', content: text === '' ? null : text };
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      messages.push(out);
      continue;
    }

    // user turn: tool_result blocks become individual `tool` messages; any text
    // becomes a trailing user message.
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        const tr = block as AnthropicToolResultBlock;
        messages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: stringifyToolResult(tr.content),
        });
      }
    }
    const userText = textOfBlocks(msg.content);
    if (userText !== '') messages.push({ role: 'user', content: userText });
  }

  const out: OpenAiRequest = { model: modelId, messages };
  if (typeof req.max_tokens === 'number') out.max_tokens = req.max_tokens;
  if (typeof req.temperature === 'number') out.temperature = req.temperature;
  if (typeof req.top_p === 'number') out.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length > 0) out.stop = req.stop_sequences;
  if (req.stream !== undefined) out.stream = req.stream;

  if (req.tools) {
    out.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  if (req.tool_choice) {
    switch (req.tool_choice.type) {
      case 'auto':
        out.tool_choice = 'auto';
        break;
      case 'any':
        out.tool_choice = 'required';
        break;
      case 'tool':
        out.tool_choice = { type: 'function', function: { name: req.tool_choice.name } };
        break;
    }
  }
  return out;
}

/** Translate a non-streaming Anthropic Messages response into an OpenAI completion. */
export function responseAnthropicToOpenai(resp: AnthropicResponse): OpenAiResponse {
  const text = textOfBlocks(resp.content);
  const toolCalls: OpenAiToolCall[] = resp.content
    .filter((b): b is Extract<AnthropicContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    .map((b) => ({
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));

  const message: OpenAiMessage = { role: 'assistant', content: text === '' ? null : text };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const inputTokens = resp.usage?.input_tokens ?? 0;
  const outputTokens = resp.usage?.output_tokens ?? 0;
  return {
    id: resp.id ?? `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [{ index: 0, message, finish_reason: stopReasonToFinishReason(resp.stop_reason) }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

/**
 * Stateful transformer: Anthropic SSE events → OpenAI Chat Completions chunk frames.
 * Used by the reserved route's response leg (an OpenAI client reading an Anthropic
 * upstream). Feed each decoded `SseEvent`; it returns zero or more `data: …` frames,
 * terminating with `data: [DONE]`.
 */
export function createAnthropicToOpenaiStream(): (event: SseEvent) => string[] {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let model = 'unknown';
  let sentRole = false;
  // Anthropic content-block index → OpenAI tool_call index (text blocks are skipped).
  const toolIndexByBlock = new Map<number, number>();
  let nextToolIndex = 0;

  function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
    return openAiFrame(
      JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      }),
    );
  }

  return (event: SseEvent): string[] => {
    const type = event.event ?? '';
    let payload: Record<string, unknown> = {};
    try {
      payload = event.data ? (JSON.parse(event.data) as Record<string, unknown>) : {};
    } catch {
      return [];
    }

    switch (type) {
      case 'message_start': {
        const msg = (payload.message ?? {}) as { model?: string };
        if (typeof msg.model === 'string') model = msg.model;
        sentRole = true;
        return [chunk({ role: 'assistant', content: '' })];
      }
      case 'content_block_start': {
        const index = typeof payload.index === 'number' ? payload.index : 0;
        const block = (payload.content_block ?? {}) as { type?: string; id?: string; name?: string };
        if (block.type === 'tool_use') {
          const toolIndex = nextToolIndex++;
          toolIndexByBlock.set(index, toolIndex);
          return [
            chunk({
              tool_calls: [
                { index: toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } },
              ],
            }),
          ];
        }
        return [];
      }
      case 'content_block_delta': {
        const index = typeof payload.index === 'number' ? payload.index : 0;
        const delta = (payload.delta ?? {}) as { type?: string; text?: string; partial_json?: string };
        const frames: string[] = [];
        if (!sentRole) {
          frames.push(chunk({ role: 'assistant', content: '' }));
          sentRole = true;
        }
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          frames.push(chunk({ content: delta.text }));
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const toolIndex = toolIndexByBlock.get(index) ?? 0;
          frames.push(chunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] }));
        }
        return frames;
      }
      case 'message_delta': {
        const delta = (payload.delta ?? {}) as { stop_reason?: string | null };
        const finish = stopReasonToFinishReason(delta.stop_reason) ?? 'stop';
        return [chunk({}, finish)];
      }
      case 'message_stop':
        return [openAiFrame('[DONE]')];
      default:
        // ping, content_block_stop, unknown → nothing to emit for OpenAI.
        return [];
    }
  };
}
