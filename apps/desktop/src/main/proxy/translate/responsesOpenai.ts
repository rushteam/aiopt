// OpenAI Responses ⇄ OpenAI Chat Completions transforms (pure).
//
// Used by the cross-format route codex/grok (Responses) → a Chat Completions provider
// (DeepSeek / Kimi-openai / relay). The REQUEST leg lowers a Responses body to Chat
// Completions; the RESPONSE + STREAM legs lift the Chat reply back into a Responses
// envelope so the Responses client can read it. Both dialects are OpenAI-branded but
// have different wire shapes — see shared/aiProviders.ts (ApiFormat) for why they are
// distinct formats. No I/O, no Electron: unit-testable with plain fixtures.
//
// Reasoning is DROPPED on this pair: Chat Completions has no mechanism to echo a
// model's reasoning back across turns, so a `reasoning` input item is discarded and a
// top-level `reasoning.effort` is best-effort mapped to `reasoning_effort` (providers
// that don't understand it ignore it). The lossless bridge lives on the Anthropic pair.

import { randomUUID } from 'node:crypto';
import { namedEventFrame, type SseEvent } from './streaming';
import {
  assertNoUnsupportedResponsesFields,
  isIncompleteStop,
  type OpenAiMessage,
  type OpenAiRequest,
  type OpenAiResponse,
  type OpenAiToolCall,
  type ResponsesContentPart,
  type ResponsesFunctionCallItem,
  type ResponsesFunctionCallOutputItem,
  type ResponsesFunctionTool,
  type ResponsesInputItem,
  type ResponsesMessageItem,
  type ResponsesOutputItem,
  type ResponsesRequest,
  type ResponsesResponse,
  type ResponsesTextPart,
} from './types';

/** Concatenate the text of a Responses message content (string or input/output_text parts). */
export function textOfParts(content: string | ResponsesContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is ResponsesTextPart => p.type === 'input_text' || p.type === 'output_text')
    .map((p) => p.text)
    .join('');
}

/** Normalize a Responses `input` (bare string = single user message) into an item list. */
export function inputItems(input: string | ResponsesInputItem[]): ResponsesInputItem[] {
  if (typeof input === 'string') {
    return [{ type: 'message', role: 'user', content: input } satisfies ResponsesMessageItem];
  }
  return input;
}

/** Map a Responses `tool_choice` to the Chat Completions form. */
function mapToolChoice(choice: unknown): unknown {
  if (typeof choice === 'string') return choice; // 'auto' | 'none' | 'required'
  if (choice && typeof choice === 'object') {
    const c = choice as { type?: string; name?: string; function?: { name?: string } };
    const name = c.name ?? c.function?.name;
    if (c.type === 'function' && name) return { type: 'function', function: { name } };
  }
  return undefined;
}

/** Translate a Responses request body into an OpenAI Chat Completions body. */
export function requestResponsesToOpenai(req: ResponsesRequest, modelId: string): OpenAiRequest {
  assertNoUnsupportedResponsesFields(req);

  const messages: OpenAiMessage[] = [];
  if (typeof req.instructions === 'string' && req.instructions !== '') {
    messages.push({ role: 'system', content: req.instructions });
  }

  for (const item of inputItems(req.input)) {
    switch (item.type) {
      case 'message': {
        const m = item as ResponsesMessageItem;
        const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : 'system';
        messages.push({ role, content: textOfParts(m.content) });
        break;
      }
      case 'function_call': {
        const fc = item as ResponsesFunctionCallItem;
        const toolCall: OpenAiToolCall = {
          id: fc.call_id,
          type: 'function',
          function: { name: fc.name, arguments: fc.arguments ?? '' },
        };
        // Coalesce onto the preceding assistant turn when there is one; else open a new
        // assistant message carrying only the tool call.
        const last = messages[messages.length - 1];
        if (last && last.role === 'assistant') {
          (last.tool_calls ??= []).push(toolCall);
        } else {
          messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
        }
        break;
      }
      case 'function_call_output': {
        const fo = item as ResponsesFunctionCallOutputItem;
        messages.push({ role: 'tool', tool_call_id: fo.call_id, content: fo.output ?? '' });
        break;
      }
      // reasoning items and any unknown item type: dropped (guard already refused images
      // and built-in tools). Chat Completions cannot echo reasoning across turns.
      default:
        break;
    }
  }

  const out: OpenAiRequest = { model: modelId, messages };
  if (typeof req.max_output_tokens === 'number') out.max_tokens = req.max_output_tokens;
  if (typeof req.temperature === 'number') out.temperature = req.temperature;
  if (typeof req.top_p === 'number') out.top_p = req.top_p;
  if (req.stream !== undefined) out.stream = req.stream;
  // Best-effort: some OpenAI-compatible providers honor reasoning_effort, others ignore it.
  if (req.reasoning?.effort) out.reasoning_effort = req.reasoning.effort;

  if (req.tools) {
    out.tools = req.tools.map((t) => {
      const fn = t as ResponsesFunctionTool;
      return { type: 'function', function: { name: fn.name, description: fn.description, parameters: fn.parameters } };
    });
  }
  const toolChoice = mapToolChoice(req.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  return out;
}

/** Translate a non-streaming OpenAI Chat completion into a Responses response envelope. */
export function responseOpenaiToResponses(resp: OpenAiResponse): ResponsesResponse {
  const choice = resp.choices?.[0];
  const message = choice?.message ?? { role: 'assistant', content: null };
  const output: ResponsesOutputItem[] = [];

  if (typeof message.content === 'string' && message.content !== '') {
    output.push({
      type: 'message',
      id: `msg_${randomUUID()}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: message.content, annotations: [] }],
    });
  }
  for (const tc of message.tool_calls ?? []) {
    output.push({
      type: 'function_call',
      id: `fc_${randomUUID()}`,
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments ?? '',
      status: 'completed',
    });
  }

  const incomplete = isIncompleteStop(choice?.finish_reason);
  const inputTokens = resp.usage?.prompt_tokens ?? 0;
  const outputTokens = resp.usage?.completion_tokens ?? 0;
  const out: ResponsesResponse = {
    id: resp.id ? `resp_${resp.id}` : `resp_${randomUUID()}`,
    object: 'response',
    created_at: resp.created ?? Math.floor(Date.now() / 1000),
    status: incomplete ? 'incomplete' : 'completed',
    model: resp.model,
    output,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  };
  if (incomplete) out.incomplete_details = { reason: 'max_output_tokens' };
  return out;
}

/**
 * Stateful transformer: OpenAI Chat Completions chunk frames → OpenAI Responses SSE
 * events. Emits the Responses envelope the client expects: `response.created` →
 * per-item `response.output_item.added` (+ `content_part.added` for a message) →
 * `output_text.delta` / `function_call_arguments.delta` → the matching `.done` events →
 * `response.completed`. Feed each decoded OpenAI `data:` frame; handles `[DONE]`.
 */
export function createOpenaiToResponsesStream(): (event: SseEvent) => string[] {
  const responseId = `resp_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let model = 'unknown';
  let seq = 0;
  let createdSent = false;
  let finished = false;
  let nextOutputIndex = 0;

  // The single open output item (Chat streams text then tools sequentially per choice).
  type OpenItem =
    | { kind: 'text'; index: number; id: string; text: string }
    | { kind: 'tool'; index: number; id: string; callId: string; name: string; args: string };
  let open: OpenItem | null = null;
  const doneItems: ResponsesOutputItem[] = [];
  const toolByOaiIndex = new Map<number, OpenItem & { kind: 'tool' }>();

  function frame(event: string, data: Record<string, unknown>): string {
    return namedEventFrame(event, { type: event, sequence_number: seq++, ...data });
  }

  function ensureCreated(frames: string[]): void {
    if (createdSent) return;
    createdSent = true;
    frames.push(
      frame('response.created', {
        response: {
          id: responseId,
          object: 'response',
          created_at: created,
          status: 'in_progress',
          model,
          output: [],
        },
      }),
    );
  }

  function closeOpen(frames: string[]): void {
    if (!open) return;
    if (open.kind === 'text') {
      frames.push(
        frame('response.output_text.done', {
          item_id: open.id,
          output_index: open.index,
          content_index: 0,
          text: open.text,
        }),
      );
      frames.push(
        frame('response.content_part.done', {
          item_id: open.id,
          output_index: open.index,
          content_index: 0,
          part: { type: 'output_text', text: open.text, annotations: [] },
        }),
      );
      const item: ResponsesOutputItem = {
        type: 'message',
        id: open.id,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: open.text, annotations: [] }],
      };
      doneItems.push(item);
      frames.push(frame('response.output_item.done', { output_index: open.index, item }));
    } else {
      frames.push(
        frame('response.function_call_arguments.done', {
          item_id: open.id,
          output_index: open.index,
          arguments: open.args,
        }),
      );
      const item: ResponsesOutputItem = {
        type: 'function_call',
        id: open.id,
        call_id: open.callId,
        name: open.name,
        arguments: open.args,
        status: 'completed',
      };
      doneItems.push(item);
      frames.push(frame('response.output_item.done', { output_index: open.index, item }));
    }
    open = null;
  }

  function openText(frames: string[]): OpenItem & { kind: 'text' } {
    if (open?.kind === 'text') return open;
    closeOpen(frames);
    const index = nextOutputIndex++;
    const id = `msg_${randomUUID()}`;
    frames.push(
      frame('response.output_item.added', {
        output_index: index,
        item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] },
      }),
    );
    frames.push(
      frame('response.content_part.added', {
        item_id: id,
        output_index: index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }),
    );
    open = { kind: 'text', index, id, text: '' };
    return open;
  }

  function openTool(frames: string[], oaiIndex: number, id: string | undefined, name: string | undefined): OpenItem & { kind: 'tool' } {
    const existing = toolByOaiIndex.get(oaiIndex);
    if (existing) return existing;
    closeOpen(frames);
    const index = nextOutputIndex++;
    const callId = id ?? `call_${randomUUID()}`;
    const itemId = `fc_${randomUUID()}`;
    frames.push(
      frame('response.output_item.added', {
        output_index: index,
        item: { type: 'function_call', id: itemId, call_id: callId, name: name ?? '', arguments: '', status: 'in_progress' },
      }),
    );
    const tool = { kind: 'tool' as const, index, id: itemId, callId, name: name ?? '', args: '' };
    open = tool;
    toolByOaiIndex.set(oaiIndex, tool);
    return tool;
  }

  function complete(frames: string[], finishReason: string | null): void {
    if (finished) return;
    closeOpen(frames);
    const incomplete = isIncompleteStop(finishReason);
    const response: Record<string, unknown> = {
      id: responseId,
      object: 'response',
      created_at: created,
      status: incomplete ? 'incomplete' : 'completed',
      model,
      output: doneItems,
    };
    if (incomplete) response.incomplete_details = { reason: 'max_output_tokens' };
    frames.push(frame(incomplete ? 'response.incomplete' : 'response.completed', { response }));
    finished = true;
  }

  return (event: SseEvent): string[] => {
    const data = event.data.trim();
    if (data === '') return [];
    const frames: string[] = [];
    if (data === '[DONE]') {
      ensureCreated(frames);
      complete(frames, null);
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
    if (typeof payload.model === 'string') model = payload.model;
    ensureCreated(frames);

    const choice = payload.choices?.[0];
    const delta = (choice?.delta ?? {}) as {
      content?: unknown;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };

    if (typeof delta.content === 'string' && delta.content !== '') {
      const item = openText(frames);
      item.text += delta.content;
      frames.push(
        frame('response.output_text.delta', {
          item_id: item.id,
          output_index: item.index,
          content_index: 0,
          delta: delta.content,
        }),
      );
    }

    for (const tc of delta.tool_calls ?? []) {
      const oaiIndex = typeof tc.index === 'number' ? tc.index : 0;
      const item = openTool(frames, oaiIndex, tc.id, tc.function?.name);
      const args = tc.function?.arguments;
      if (typeof args === 'string' && args !== '') {
        item.args += args;
        frames.push(
          frame('response.function_call_arguments.delta', {
            item_id: item.id,
            output_index: item.index,
            delta: args,
          }),
        );
      }
    }

    if (choice?.finish_reason != null) complete(frames, choice.finish_reason);
    return frames;
  };
}
