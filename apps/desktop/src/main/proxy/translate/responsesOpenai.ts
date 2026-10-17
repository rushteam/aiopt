// OpenAI Responses ⇄ OpenAI Chat Completions transforms (pure).
//
// Used by the cross-format route codex/grok (Responses) → a Chat Completions provider
// (DeepSeek / Kimi-openai / relay). The REQUEST leg lowers a Responses body to Chat
// Completions; the RESPONSE + STREAM legs lift the Chat reply back into a Responses
// envelope so the Responses client can read it. Both dialects are OpenAI-branded but
// have different wire shapes — see shared/aiProviders.ts (ApiFormat) for why they are
// distinct formats. No I/O, no Electron: unit-testable with plain fixtures.
//
// Reasoning: a Chat upstream's `reasoning_content` is lifted into a Responses `reasoning`
// item (unsigned, via reasoningBridge.ts) and, when the client echoes that item back,
// replayed as `reasoning_content` on the assistant turn it precedes — thinking-mode
// upstreams (DeepSeek, Kimi, MiMo …) 400 a post-tool-call turn without it. Reasoning items
// from any other producer (signed Anthropic, OpenAI's own encrypted reasoning) are
// dropped. A top-level `reasoning.effort` is best-effort mapped to `reasoning_effort`.

import { randomUUID } from 'node:crypto';
import { namedEventFrame, type SseEvent } from './streaming';
import { decodeReasoning, encodeReasoning } from './reasoningBridge';
import {
  assertNoUnsupportedResponsesFields,
  isIncompleteStop,
  rejectUnsupported,
  type OpenAiContentPart,
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
  type ResponsesReasoningItem,
  type ResponsesRequest,
  type ResponsesResponse,
  type ResponsesTextPart,
} from './types';
import { responsesImageUrl } from './images';

/** Concatenate the text of a Responses message content (string or input/output_text parts). */
export function textOfParts(content: string | ResponsesContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is ResponsesTextPart => p.type === 'input_text' || p.type === 'output_text')
    .map((p) => p.text)
    .join('');
}

/** Whether a Responses message content carries an `input_image` part. */
export function hasImagePart(content: string | ResponsesContentPart[]): content is ResponsesContentPart[] {
  return Array.isArray(content) && content.some((p) => p.type === 'input_image');
}

/** Refuse an image anywhere but a user turn (no dialect carries one on another role). */
export function assertImageOnUserTurn(m: ResponsesMessageItem): void {
  if (m.role !== 'user' && hasImagePart(m.content)) {
    rejectUnsupported(`Responses \`input_image\` on a ${m.role} message is not supported by the translation proxy`);
  }
}

/** A user message's parts → Chat content parts (text + image_url), in order. */
function chatPartsOf(content: ResponsesContentPart[]): OpenAiContentPart[] {
  const parts: OpenAiContentPart[] = [];
  for (const p of content) {
    if (p.type === 'input_image') parts.push({ type: 'image_url', image_url: { url: responsesImageUrl(p) } });
    else if ((p.type === 'input_text' || p.type === 'output_text') && (p as ResponsesTextPart).text !== '') {
      parts.push({ type: 'text', text: (p as ResponsesTextPart).text });
    }
  }
  return parts;
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
  // Reasoning echoed back ahead of an assistant turn, waiting for that turn to attach to.
  let pendingReasoning = '';
  const takeReasoning = (m: OpenAiMessage): void => {
    if (pendingReasoning !== '') m.reasoning_content = (m.reasoning_content ?? '') + pendingReasoning;
    pendingReasoning = '';
  };

  for (const item of inputItems(req.input)) {
    if (item.type !== 'reasoning' && item.type !== 'message' && item.type !== 'function_call') pendingReasoning = '';
    switch (item.type) {
      case 'message': {
        const m = item as ResponsesMessageItem;
        const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : 'system';
        assertImageOnUserTurn(m);
        const out: OpenAiMessage = {
          role,
          content: hasImagePart(m.content) ? chatPartsOf(m.content) : textOfParts(m.content),
        };
        if (role === 'assistant') takeReasoning(out);
        else pendingReasoning = '';
        messages.push(out);
        break;
      }
      case 'reasoning': {
        // Only our own unsigned bridge (a Chat upstream's reasoning_content) is replayed.
        const decoded = decodeReasoning((item as ResponsesReasoningItem).encrypted_content);
        if (decoded && decoded.signature === '' && decoded.thinking !== '') pendingReasoning += decoded.thinking;
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
        if (last && last.role === 'assistant' && pendingReasoning === '') {
          (last.tool_calls ??= []).push(toolCall);
        } else {
          const out: OpenAiMessage = { role: 'assistant', content: null, tool_calls: [toolCall] };
          takeReasoning(out);
          messages.push(out);
        }
        break;
      }
      case 'function_call_output': {
        const fo = item as ResponsesFunctionCallOutputItem;
        messages.push({ role: 'tool', tool_call_id: fo.call_id, content: fo.output ?? '' });
        break;
      }
      // Any unknown item type: dropped (the guard already refused images and built-in tools).
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

/** A Chat message / delta's reasoning text (`reasoning_content`, or the `reasoning` alias). */
function reasoningText(m: Record<string, unknown>): string {
  if (typeof m.reasoning_content === 'string') return m.reasoning_content;
  if (typeof m.reasoning === 'string') return m.reasoning;
  return '';
}

/**
 * A Responses reasoning item for a Chat upstream's reasoning: the readable text as a
 * summary (codex shows it), plus the unsigned bridge payload the client echoes back.
 */
function reasoningItem(id: string, text: string): ResponsesOutputItem {
  return {
    type: 'reasoning',
    id,
    summary: [{ type: 'summary_text', text }],
    encrypted_content: encodeReasoning({ thinking: text, signature: '' }),
  };
}

/** Translate a non-streaming OpenAI Chat completion into a Responses response envelope. */
export function responseOpenaiToResponses(resp: OpenAiResponse): ResponsesResponse {
  const choice = resp.choices?.[0];
  const message = choice?.message ?? { role: 'assistant', content: null };
  const output: ResponsesOutputItem[] = [];

  const reasoning = reasoningText(message as unknown as Record<string, unknown>);
  if (reasoning !== '') output.push(reasoningItem(`rs_${randomUUID()}`, reasoning));
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
    | { kind: 'reasoning'; index: number; id: string; text: string }
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
    } else if (open.kind === 'reasoning') {
      const part = { type: 'summary_text', text: open.text };
      frames.push(
        frame('response.reasoning_summary_text.done', {
          item_id: open.id,
          output_index: open.index,
          summary_index: 0,
          text: open.text,
        }),
      );
      frames.push(
        frame('response.reasoning_summary_part.done', { item_id: open.id, output_index: open.index, summary_index: 0, part }),
      );
      const item = reasoningItem(open.id, open.text);
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

  function openReasoning(frames: string[]): OpenItem & { kind: 'reasoning' } {
    if (open?.kind === 'reasoning') return open;
    closeOpen(frames);
    const index = nextOutputIndex++;
    const id = `rs_${randomUUID()}`;
    frames.push(frame('response.output_item.added', { output_index: index, item: { type: 'reasoning', id, summary: [] } }));
    frames.push(
      frame('response.reasoning_summary_part.added', {
        item_id: id,
        output_index: index,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }),
    );
    open = { kind: 'reasoning', index, id, text: '' };
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
      [key: string]: unknown;
      content?: unknown;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };

    const reasoning = reasoningText(delta);
    if (reasoning !== '') {
      const item = openReasoning(frames);
      item.text += reasoning;
      frames.push(
        frame('response.reasoning_summary_text.delta', {
          item_id: item.id,
          output_index: item.index,
          summary_index: 0,
          delta: reasoning,
        }),
      );
    }

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
