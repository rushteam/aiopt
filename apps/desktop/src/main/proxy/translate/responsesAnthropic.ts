// OpenAI Responses ⇄ Anthropic Messages transforms (pure), with the reasoning bridge.
//
// Used by the cross-format route codex/grok (Responses) → an Anthropic provider. The
// REQUEST leg lowers a Responses body to Anthropic Messages; the RESPONSE + STREAM legs
// lift the Anthropic reply back into a Responses envelope.
//
// THE REASONING BRIDGE (Anthropic-specific, why this pair is its own module):
// Anthropic extended thinking returns a `thinking` block carrying an opaque `signature`
// that MUST be replayed verbatim on the next turn or the model rejects the continuation.
// The Responses client (codex) is stateless — it echoes back whatever output items it
// received. So on the RESPONSE leg we fold {thinking, signature} into a Responses
// `reasoning` item's opaque `encrypted_content` (base64 of JSON); on the REQUEST leg we
// decode it back into an Anthropic `thinking` block. base64 is ENCODING, not encryption
// — it is a format bridge, not a security boundary. The payload is the model's own
// thinking + signature (not a key), but per the proxy rules it is NEVER logged and never
// reaches the renderer. No I/O, no Electron.

import { randomUUID } from 'node:crypto';
import { namedEventFrame, type SseEvent } from './streaming';
import { inputItems, textOfParts } from './responsesOpenai';
import {
  assertNoUnsupportedResponsesFields,
  isIncompleteStop,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicRequest,
  type AnthropicResponse,
  type AnthropicTool,
  type ResponsesFunctionCallItem,
  type ResponsesFunctionCallOutputItem,
  type ResponsesFunctionTool,
  type ResponsesMessageItem,
  type ResponsesOutputItem,
  type ResponsesReasoningItem,
  type ResponsesRequest,
  type ResponsesResponse,
} from './types';

/** Anthropic requires max_tokens; when a Responses request omits it, fall back to this. */
export const DEFAULT_MAX_TOKENS = 4096;

/** Decoded extended-thinking payload carried across turns by the bridge. */
export interface ReasoningPayload {
  thinking: string;
  signature: string;
}

/** Fold a thinking block into the opaque string a Responses reasoning item carries. */
export function encodeReasoning(payload: ReasoningPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/**
 * Recover a thinking block from a Responses reasoning item's opaque field. Returns null
 * on any malformed input (missing / non-base64 / wrong shape) so a corrupt echo degrades
 * to "no bridged thinking" rather than throwing — the turn proceeds without continuity.
 */
export function decodeReasoning(encoded: string | null | undefined): ReasoningPayload | null {
  if (typeof encoded !== 'string' || encoded === '') return null;
  try {
    const obj = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Partial<ReasoningPayload>;
    if (obj && typeof obj.thinking === 'string' && typeof obj.signature === 'string') {
      return { thinking: obj.thinking, signature: obj.signature };
    }
  } catch {
    // fall through
  }
  return null;
}

function parseArguments(args: string | undefined): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

/** low/medium/high reasoning effort → an Anthropic thinking token budget. */
function effortToBudget(effort: string | undefined): number {
  switch (effort) {
    case 'low':
      return 1024;
    case 'high':
      return 16384;
    case 'medium':
    default:
      return 8192;
  }
}

/** Translate a Responses request body into an Anthropic Messages body (bridge on input). */
export function requestResponsesToAnthropic(req: ResponsesRequest, modelId: string): AnthropicRequest {
  assertNoUnsupportedResponsesFields(req);

  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  /** Get the trailing assistant message's block array, opening a new one if needed. */
  const assistantBlocks = (): AnthropicContentBlock[] => {
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && Array.isArray(last.content)) return last.content;
    const blocks: AnthropicContentBlock[] = [];
    messages.push({ role: 'assistant', content: blocks });
    return blocks;
  };

  /** Append a tool_result to the trailing user turn, or open one (mirrors openaiToAnthropic). */
  const pushToolResult = (toolUseId: string, content: string): void => {
    const block: AnthropicContentBlock = { type: 'tool_result', tool_use_id: toolUseId, content };
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
    else messages.push({ role: 'user', content: [block] });
  };

  if (typeof req.instructions === 'string' && req.instructions !== '') systemParts.push(req.instructions);

  for (const item of inputItems(req.input)) {
    switch (item.type) {
      case 'message': {
        const m = item as ResponsesMessageItem;
        const text = textOfParts(m.content);
        if (m.role === 'system' || m.role === 'developer') {
          if (text !== '') systemParts.push(text);
        } else if (m.role === 'assistant') {
          if (text !== '') assistantBlocks().push({ type: 'text', text });
        } else {
          messages.push({ role: 'user', content: text });
        }
        break;
      }
      case 'function_call': {
        const fc = item as ResponsesFunctionCallItem;
        assistantBlocks().push({
          type: 'tool_use',
          id: fc.call_id,
          name: fc.name,
          input: parseArguments(fc.arguments),
        });
        break;
      }
      case 'function_call_output': {
        const fo = item as ResponsesFunctionCallOutputItem;
        pushToolResult(fo.call_id, fo.output ?? '');
        break;
      }
      case 'reasoning': {
        // Bridge: decode the echoed reasoning item back into a thinking block so the
        // signature is replayed verbatim. Malformed → skip (no continuity, not fatal).
        const decoded = decodeReasoning((item as ResponsesReasoningItem).encrypted_content);
        if (decoded) {
          assistantBlocks().unshift({
            type: 'thinking',
            thinking: decoded.thinking,
            signature: decoded.signature,
          } as AnthropicContentBlock);
        }
        break;
      }
      default:
        break;
    }
  }

  let maxTokens = typeof req.max_output_tokens === 'number' ? req.max_output_tokens : DEFAULT_MAX_TOKENS;
  const out: AnthropicRequest = { model: modelId, messages, max_tokens: maxTokens };
  if (systemParts.length > 0) out.system = systemParts.join('\n\n');
  if (req.stream !== undefined) out.stream = req.stream;

  const effort = req.reasoning?.effort;
  if (effort) {
    // Extended thinking: budget must be < max_tokens and ≥ 1024. Bump max_tokens if the
    // requested budget would not fit. Anthropic disallows temperature/top_p with thinking,
    // so those are intentionally NOT forwarded in this branch.
    let budget = effortToBudget(effort);
    if (budget >= maxTokens) maxTokens = budget + DEFAULT_MAX_TOKENS;
    budget = Math.max(1024, Math.min(budget, maxTokens - 1));
    out.max_tokens = maxTokens;
    out.thinking = { type: 'enabled', budget_tokens: budget };
  } else {
    if (typeof req.temperature === 'number') out.temperature = req.temperature;
    if (typeof req.top_p === 'number') out.top_p = req.top_p;
  }

  if (req.tools) {
    out.tools = req.tools.map((t): AnthropicTool => {
      const fn = t as ResponsesFunctionTool;
      return {
        name: fn.name,
        description: fn.description,
        input_schema: fn.parameters ?? { type: 'object', properties: {} },
      };
    });
  }
  if (typeof req.tool_choice === 'string') {
    if (req.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
    else if (req.tool_choice === 'required') out.tool_choice = { type: 'any' };
    // 'none' → leave unset.
  } else if (req.tool_choice && typeof req.tool_choice === 'object') {
    const c = req.tool_choice as { type?: string; name?: string; function?: { name?: string } };
    const name = c.name ?? c.function?.name;
    if (c.type === 'function' && name) out.tool_choice = { type: 'tool', name };
  }
  return out;
}

/** Translate a non-streaming Anthropic response into a Responses envelope (bridge on output). */
export function responseAnthropicToResponses(resp: AnthropicResponse): ResponsesResponse {
  const reasoningItems: ResponsesOutputItem[] = [];
  const toolItems: ResponsesOutputItem[] = [];
  let text = '';

  for (const block of resp.content ?? []) {
    if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      text += (block as { text: string }).text;
    } else if (block.type === 'thinking') {
      const b = block as unknown as { thinking?: string; signature?: string };
      reasoningItems.push({
        type: 'reasoning',
        id: `rs_${randomUUID()}`,
        summary: [],
        encrypted_content: encodeReasoning({ thinking: b.thinking ?? '', signature: b.signature ?? '' }),
      });
    } else if (block.type === 'tool_use') {
      const b = block as Extract<AnthropicContentBlock, { type: 'tool_use' }>;
      toolItems.push({
        type: 'function_call',
        id: `fc_${randomUUID()}`,
        call_id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
        status: 'completed',
      });
    }
  }

  const output: ResponsesOutputItem[] = [...reasoningItems];
  if (text !== '') {
    output.push({
      type: 'message',
      id: `msg_${randomUUID()}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  output.push(...toolItems);

  const incomplete = isIncompleteStop(resp.stop_reason);
  const inputTokens = resp.usage?.input_tokens ?? 0;
  const outputTokens = resp.usage?.output_tokens ?? 0;
  const out: ResponsesResponse = {
    id: resp.id ? `resp_${resp.id}` : `resp_${randomUUID()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: incomplete ? 'incomplete' : 'completed',
    model: resp.model,
    output,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  };
  if (incomplete) out.incomplete_details = { reason: 'max_output_tokens' };
  return out;
}

/**
 * Stateful transformer: Anthropic SSE events → OpenAI Responses SSE events, bridging
 * thinking blocks. Each Anthropic content block is reserved a Responses output_index at
 * `content_block_start` (so ordering — reasoning before message/tool — is preserved) and
 * finalized at `content_block_stop`. Thinking deltas/signature are buffered and emitted
 * as one reasoning item carrying `encrypted_content`.
 */
export function createAnthropicToResponsesStream(): (event: SseEvent) => string[] {
  const responseId = `resp_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let model = 'unknown';
  let seq = 0;
  let createdSent = false;
  let finished = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null = null;
  let nextOutputIndex = 0;

  type Block =
    | { kind: 'text'; index: number; id: string; text: string }
    | { kind: 'tool'; index: number; id: string; callId: string; name: string; args: string }
    | { kind: 'thinking'; index: number; id: string; thinking: string; signature: string };
  const blocks = new Map<number, Block>();
  const doneItems: ResponsesOutputItem[] = [];

  function frame(event: string, data: Record<string, unknown>): string {
    return namedEventFrame(event, { type: event, sequence_number: seq++, ...data });
  }
  function ensureCreated(frames: string[]): void {
    if (createdSent) return;
    createdSent = true;
    frames.push(
      frame('response.created', {
        response: { id: responseId, object: 'response', created_at: created, status: 'in_progress', model, output: [] },
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
    const frames: string[] = [];

    switch (type) {
      case 'message_start': {
        const msg = (payload.message ?? {}) as { model?: string; usage?: { input_tokens?: number } };
        if (typeof msg.model === 'string') model = msg.model;
        if (typeof msg.usage?.input_tokens === 'number') inputTokens = msg.usage.input_tokens;
        ensureCreated(frames);
        return frames;
      }
      case 'content_block_start': {
        ensureCreated(frames);
        const index = typeof payload.index === 'number' ? payload.index : 0;
        const cb = (payload.content_block ?? {}) as { type?: string; id?: string; name?: string };
        const outputIndex = nextOutputIndex++;
        if (cb.type === 'tool_use') {
          const itemId = `fc_${randomUUID()}`;
          const callId = cb.id ?? `call_${randomUUID()}`;
          blocks.set(index, { kind: 'tool', index: outputIndex, id: itemId, callId, name: cb.name ?? '', args: '' });
          frames.push(
            frame('response.output_item.added', {
              output_index: outputIndex,
              item: { type: 'function_call', id: itemId, call_id: callId, name: cb.name ?? '', arguments: '', status: 'in_progress' },
            }),
          );
        } else if (cb.type === 'thinking') {
          const itemId = `rs_${randomUUID()}`;
          blocks.set(index, { kind: 'thinking', index: outputIndex, id: itemId, thinking: '', signature: '' });
          frames.push(
            frame('response.output_item.added', {
              output_index: outputIndex,
              item: { type: 'reasoning', id: itemId, summary: [] },
            }),
          );
        } else {
          // text (default)
          const itemId = `msg_${randomUUID()}`;
          blocks.set(index, { kind: 'text', index: outputIndex, id: itemId, text: '' });
          frames.push(
            frame('response.output_item.added', {
              output_index: outputIndex,
              item: { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [] },
            }),
          );
          frames.push(
            frame('response.content_part.added', {
              item_id: itemId,
              output_index: outputIndex,
              content_index: 0,
              part: { type: 'output_text', text: '', annotations: [] },
            }),
          );
        }
        return frames;
      }
      case 'content_block_delta': {
        const index = typeof payload.index === 'number' ? payload.index : 0;
        const block = blocks.get(index);
        if (!block) return frames;
        const delta = (payload.delta ?? {}) as {
          type?: string;
          text?: string;
          partial_json?: string;
          thinking?: string;
          signature?: string;
        };
        if (block.kind === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string') {
          block.text += delta.text;
          frames.push(
            frame('response.output_text.delta', {
              item_id: block.id,
              output_index: block.index,
              content_index: 0,
              delta: delta.text,
            }),
          );
        } else if (block.kind === 'tool' && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          block.args += delta.partial_json;
          frames.push(
            frame('response.function_call_arguments.delta', {
              item_id: block.id,
              output_index: block.index,
              delta: delta.partial_json,
            }),
          );
        } else if (block.kind === 'thinking') {
          // Buffer only — the bridge payload is opaque, emitted whole at block stop.
          if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') block.thinking += delta.thinking;
          else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') block.signature += delta.signature;
        }
        return frames;
      }
      case 'content_block_stop': {
        const index = typeof payload.index === 'number' ? payload.index : 0;
        const block = blocks.get(index);
        if (!block) return frames;
        if (block.kind === 'text') {
          frames.push(frame('response.output_text.done', { item_id: block.id, output_index: block.index, content_index: 0, text: block.text }));
          frames.push(
            frame('response.content_part.done', {
              item_id: block.id,
              output_index: block.index,
              content_index: 0,
              part: { type: 'output_text', text: block.text, annotations: [] },
            }),
          );
          const item: ResponsesOutputItem = {
            type: 'message',
            id: block.id,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: block.text, annotations: [] }],
          };
          doneItems.push(item);
          frames.push(frame('response.output_item.done', { output_index: block.index, item }));
        } else if (block.kind === 'tool') {
          frames.push(frame('response.function_call_arguments.done', { item_id: block.id, output_index: block.index, arguments: block.args }));
          const item: ResponsesOutputItem = {
            type: 'function_call',
            id: block.id,
            call_id: block.callId,
            name: block.name,
            arguments: block.args,
            status: 'completed',
          };
          doneItems.push(item);
          frames.push(frame('response.output_item.done', { output_index: block.index, item }));
        } else {
          const item: ResponsesOutputItem = {
            type: 'reasoning',
            id: block.id,
            summary: [],
            encrypted_content: encodeReasoning({ thinking: block.thinking, signature: block.signature }),
          };
          doneItems.push(item);
          frames.push(frame('response.output_item.done', { output_index: block.index, item }));
        }
        return frames;
      }
      case 'message_delta': {
        const delta = (payload.delta ?? {}) as { stop_reason?: string | null };
        if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
        const usage = (payload.usage ?? {}) as { output_tokens?: number };
        if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
        return frames;
      }
      case 'message_stop': {
        if (finished) return frames;
        finished = true;
        const incomplete = isIncompleteStop(stopReason);
        const response: Record<string, unknown> = {
          id: responseId,
          object: 'response',
          created_at: created,
          status: incomplete ? 'incomplete' : 'completed',
          model,
          output: doneItems,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
        };
        if (incomplete) response.incomplete_details = { reason: 'max_output_tokens' };
        frames.push(frame(incomplete ? 'response.incomplete' : 'response.completed', { response }));
        return frames;
      }
      default:
        // ping / unknown → nothing to emit.
        return frames;
    }
  };
}
