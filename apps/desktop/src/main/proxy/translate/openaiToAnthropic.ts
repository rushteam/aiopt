// OpenAI Chat Completions → Anthropic Messages transforms (pure).
//
// This direction is used for:
//   - the ENABLED route's RESPONSE leg (OpenAI provider → claude, which reads Anthropic),
//     including the streaming path that Claude Code actually consumes, and
//   - the reserved route's REQUEST leg (an OpenAI-speaking client → Anthropic provider).
//
// See anthropicToOpenai.ts for the mirror image. Both are pure: no I/O, no Electron.

import { randomUUID } from 'node:crypto';
import type { SseEvent } from './streaming';
import { anthropicFrame } from './streaming';
import {
  assertNoUnsupportedRequestFields,
  finishReasonToStopReason,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicRequest,
  type AnthropicResponse,
  type OpenAiRequest,
  type OpenAiResponse,
} from './types';

/** Anthropic requires max_tokens; when an OpenAI request omits it, fall back to this. */
export const DEFAULT_MAX_TOKENS = 4096;

/** Best-effort JSON parse of a tool-call arguments string; falls back to an empty object. */
function parseArguments(args: string | undefined): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

/** Translate an OpenAI Chat Completions request body into an Anthropic Messages body. */
export function requestOpenaiToAnthropic(req: OpenAiRequest, modelId: string): AnthropicRequest {
  assertNoUnsupportedRequestFields(req);

  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  const pushToolResult = (toolCallId: string, content: string) => {
    const block: AnthropicContentBlock = { type: 'tool_result', tool_use_id: toolCallId, content };
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      last.content.push(block);
    } else {
      messages.push({ role: 'user', content: [block] });
    }
  };

  for (const msg of req.messages) {
    switch (msg.role) {
      case 'system':
        if (typeof msg.content === 'string') systemParts.push(msg.content);
        break;
      case 'user':
        messages.push({ role: 'user', content: typeof msg.content === 'string' ? msg.content : '' });
        break;
      case 'tool':
        pushToolResult(msg.tool_call_id ?? '', typeof msg.content === 'string' ? msg.content : '');
        break;
      case 'assistant': {
        const blocks: AnthropicContentBlock[] = [];
        if (typeof msg.content === 'string' && msg.content !== '') {
          blocks.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls ?? []) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: parseArguments(tc.function.arguments),
          });
        }
        messages.push({ role: 'assistant', content: blocks.length > 0 ? blocks : '' });
        break;
      }
    }
  }

  const out: AnthropicRequest = {
    model: modelId,
    messages,
    max_tokens: typeof req.max_tokens === 'number' ? req.max_tokens : DEFAULT_MAX_TOKENS,
  };
  if (systemParts.length > 0) out.system = systemParts.join('\n\n');
  if (typeof req.temperature === 'number') out.temperature = req.temperature;
  if (typeof req.top_p === 'number') out.top_p = req.top_p;
  if (req.stop !== undefined) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.stream !== undefined) out.stream = req.stream;

  if (req.tools) {
    out.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
  }
  if (typeof req.tool_choice === 'string') {
    if (req.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
    else if (req.tool_choice === 'required') out.tool_choice = { type: 'any' };
    // 'none' → leave unset (Anthropic defaults to auto with tools available).
  } else if (req.tool_choice && typeof req.tool_choice === 'object') {
    const fn = (req.tool_choice as { function?: { name?: string } }).function;
    if (fn?.name) out.tool_choice = { type: 'tool', name: fn.name };
  }
  return out;
}

/** Translate a non-streaming OpenAI completion into an Anthropic Messages response. */
export function responseOpenaiToAnthropic(resp: OpenAiResponse): AnthropicResponse {
  const choice = resp.choices?.[0];
  const message = choice?.message ?? { role: 'assistant', content: null };
  const content: AnthropicContentBlock[] = [];
  if (typeof message.content === 'string' && message.content !== '') {
    content.push({ type: 'text', text: message.content });
  }
  for (const tc of message.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input: parseArguments(tc.function.arguments),
    });
  }

  return {
    id: resp.id ?? `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: resp.model,
    content,
    stop_reason: finishReasonToStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * Stateful transformer: OpenAI Chat Completions chunk frames → Anthropic SSE events.
 * This is the ENABLED route's response leg — the sequence Claude Code consumes. Feed
 * each decoded `SseEvent` (an OpenAI `data:` frame); it returns the Anthropic frames to
 * forward. Handles the `data: [DONE]` sentinel and synthesizes the full Anthropic event
 * envelope (message_start → block start/delta/stop → message_delta → message_stop).
 */
export function createOpenaiToAnthropicStream(): (event: SseEvent) => string[] {
  const messageId = `msg_${randomUUID()}`;
  let model = 'unknown';
  let started = false;
  let finished = false;
  let openKind: 'text' | 'tool' | null = null;
  let openIndex = -1;
  let nextIndex = 0;
  const toolBlockByOpenAiIndex = new Map<number, number>();
  let outputTokens = 0;

  function start(frames: string[]): void {
    if (started) return;
    started = true;
    frames.push(
      anthropicFrame('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    );
  }

  function closeOpenBlock(frames: string[]): void {
    if (openKind !== null) {
      frames.push(anthropicFrame('content_block_stop', { type: 'content_block_stop', index: openIndex }));
      openKind = null;
      openIndex = -1;
    }
  }

  function finish(frames: string[], stopReason: string | null): void {
    if (finished) return;
    closeOpenBlock(frames);
    frames.push(
      anthropicFrame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }),
    );
    frames.push(anthropicFrame('message_stop', { type: 'message_stop' }));
    finished = true;
  }

  return (event: SseEvent): string[] => {
    const data = event.data.trim();
    if (data === '') return [];
    if (data === '[DONE]') {
      const frames: string[] = [];
      start(frames); // guard against an empty stream that only sent [DONE]
      finish(frames, 'end_turn');
      return frames;
    }

    let payload: {
      model?: string;
      choices?: { delta?: Record<string, unknown>; finish_reason?: string | null }[];
    };
    try {
      payload = JSON.parse(data);
    } catch {
      return [];
    }

    const frames: string[] = [];
    if (typeof payload.model === 'string') model = payload.model;
    start(frames);

    const choice = payload.choices?.[0];
    const delta = (choice?.delta ?? {}) as {
      content?: unknown;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };

    if (typeof delta.content === 'string' && delta.content !== '') {
      if (openKind !== 'text') {
        closeOpenBlock(frames);
        openKind = 'text';
        openIndex = nextIndex++;
        frames.push(
          anthropicFrame('content_block_start', {
            type: 'content_block_start',
            index: openIndex,
            content_block: { type: 'text', text: '' },
          }),
        );
      }
      frames.push(
        anthropicFrame('content_block_delta', {
          type: 'content_block_delta',
          index: openIndex,
          delta: { type: 'text_delta', text: delta.content },
        }),
      );
    }

    for (const tc of delta.tool_calls ?? []) {
      const oaiIndex = typeof tc.index === 'number' ? tc.index : 0;
      let anthropicIndex = toolBlockByOpenAiIndex.get(oaiIndex);
      if (anthropicIndex === undefined) {
        closeOpenBlock(frames);
        anthropicIndex = nextIndex++;
        toolBlockByOpenAiIndex.set(oaiIndex, anthropicIndex);
        openKind = 'tool';
        openIndex = anthropicIndex;
        frames.push(
          anthropicFrame('content_block_start', {
            type: 'content_block_start',
            index: anthropicIndex,
            content_block: { type: 'tool_use', id: tc.id ?? `toolu_${randomUUID()}`, name: tc.function?.name ?? '', input: {} },
          }),
        );
      }
      const args = tc.function?.arguments;
      if (typeof args === 'string' && args !== '') {
        frames.push(
          anthropicFrame('content_block_delta', {
            type: 'content_block_delta',
            index: anthropicIndex,
            delta: { type: 'input_json_delta', partial_json: args },
          }),
        );
      }
    }

    if (choice?.finish_reason != null) {
      finish(frames, finishReasonToStopReason(choice.finish_reason));
    }
    return frames;
  };
}
