// Wire-format shapes + guards for the OpenAI Chat Completions ⇄ Anthropic Messages
// translation proxy.
//
// These interfaces are DELIBERATELY partial: only the fields the proxy actually maps
// are typed. Everything else is either caught by an explicit unsupported-field guard
// (features that would silently corrupt output — images, extended thinking) or is
// dropped/ignored where that is safe (e.g. `cache_control`, which only affects cost).
//
// Pure module: no Node/Electron, no I/O. The one dependency is `throwIpcError` (also
// pure) so unsupported features surface as the same coded errors used everywhere else.

import { throwIpcError } from '../../ipc/validate';

/**
 * Reject a request/response feature the proxy does not translate. Uses
 * UNSUPPORTED_CAPABILITY so the caller sees a clear, generic, key-free reason.
 */
export function rejectUnsupported(message: string): never {
  throwIpcError('UNSUPPORTED_CAPABILITY', message);
}

// --- Anthropic Messages -----------------------------------------------------

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}
/** A content block we do not translate (image, thinking, …); caught by the guard. */
export interface AnthropicUnknownBlock {
  type: string;
  [key: string]: unknown;
}
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicUnknownBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

export interface AnthropicRequest {
  model?: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  [key: string]: unknown;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// --- OpenAI Chat Completions ------------------------------------------------

export interface OpenAiFunctionCall {
  name: string;
  arguments: string;
}
export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: OpenAiFunctionCall;
}
export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}
export interface OpenAiTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}
export interface OpenAiRequest {
  model?: string;
  messages: OpenAiMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: OpenAiTool[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
export interface OpenAiChoice {
  index: number;
  message: OpenAiMessage;
  finish_reason: string | null;
}
export interface OpenAiResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAiChoice[];
  usage: OpenAiUsage;
}

// --- OpenAI Responses -------------------------------------------------------
//
// The Responses API is a THIRD dialect (codex/grok speak it): a request carries an
// `input` list of typed items (not `messages`), top-level `instructions`, and
// `max_output_tokens`; a response carries an `output` list of typed items. Only the
// fields the proxy maps are typed here; images / built-in tools / previous_response_id
// are refused by {@link assertNoUnsupportedResponsesFields}. `reasoning` is PERMITTED —
// the Anthropic pair bridges it (see responsesAnthropic.ts); the Chat pair drops it.

/** A text part inside a Responses `message` item (input or output side). */
export interface ResponsesTextPart {
  type: 'input_text' | 'output_text';
  text: string;
}
/** A part we do not translate (input_image, …); caught during content mapping. */
export interface ResponsesUnknownPart {
  type: string;
  [key: string]: unknown;
}
export type ResponsesContentPart = ResponsesTextPart | ResponsesUnknownPart;

export interface ResponsesMessageItem {
  type: 'message';
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: string | ResponsesContentPart[];
}
export interface ResponsesFunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string; // JSON string
  id?: string;
}
export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}
export interface ResponsesReasoningItem {
  type: 'reasoning';
  id?: string;
  /** Opaque bridge payload (base64 JSON of {thinking, signature}); see responsesAnthropic.ts. */
  encrypted_content?: string | null;
  summary?: unknown[];
  [key: string]: unknown;
}
export interface ResponsesUnknownItem {
  type: string;
  [key: string]: unknown;
}
export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem
  | ResponsesUnknownItem;

export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
}
export interface ResponsesUnknownTool {
  type: string;
  [key: string]: unknown;
}
export type ResponsesTool = ResponsesFunctionTool | ResponsesUnknownTool;

export interface ResponsesRequest {
  model?: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: ResponsesTool[];
  tool_choice?: unknown;
  reasoning?: { effort?: string; summary?: string } | null;
  previous_response_id?: string | null;
  [key: string]: unknown;
}

/** One item in a Responses `output` array. */
export interface ResponsesOutputTextPart {
  type: 'output_text';
  text: string;
  annotations: unknown[];
}
export interface ResponsesOutputMessage {
  type: 'message';
  id: string;
  role: 'assistant';
  status: 'completed' | 'incomplete';
  content: ResponsesOutputTextPart[];
}
export interface ResponsesOutputFunctionCall {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed';
}
export interface ResponsesOutputReasoning {
  type: 'reasoning';
  id: string;
  summary: unknown[];
  encrypted_content?: string;
}
export type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall
  | ResponsesOutputReasoning;

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}
export interface ResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed' | 'incomplete';
  model: string;
  output: ResponsesOutputItem[];
  usage: ResponsesUsage;
  incomplete_details?: { reason: string };
}

/**
 * Reject the Responses request features the proxy cannot faithfully translate. Unlike
 * {@link assertNoUnsupportedRequestFields} this PERMITS `reasoning` (bridged/dropped per
 * pair). It refuses: `previous_response_id` (we force stateless replay — honoring it
 * would silently lose context the upstream never saw), built-in tools (web_search /
 * file_search / computer_use — no upstream equivalent), and image input parts.
 */
export function assertNoUnsupportedResponsesFields(req: ResponsesRequest): void {
  if (req.previous_response_id !== undefined && req.previous_response_id !== null) {
    rejectUnsupported('Responses `previous_response_id` is not supported (the proxy replays statelessly)');
  }
  for (const tool of req.tools ?? []) {
    if (tool.type !== 'function') {
      rejectUnsupported(`Responses built-in tool "${tool.type}" is not supported by the translation proxy`);
    }
  }
  const items = Array.isArray(req.input) ? req.input : [];
  for (const item of items) {
    if (item.type !== 'message') continue;
    const content = (item as ResponsesMessageItem).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type !== 'input_text' && part.type !== 'output_text') {
        rejectUnsupported(`Responses content part "${part.type}" is not supported by the translation proxy`);
      }
    }
  }
}

/** Map an OpenAI/Anthropic finish signal to a Responses top-level status. */
export function isIncompleteStop(reason: string | null | undefined): boolean {
  return reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens';
}

// --- shared mapping helpers -------------------------------------------------

/**
 * Top-level request fields we refuse to translate because passing them through (or
 * dropping them) would change semantics in a way the caller would not expect. Kept in
 * one place so both request translators reject the same set. `stream`, `temperature`,
 * `top_p`, `max_tokens`, `stop`/`stop_sequences`, `tools`, `tool_choice`, `model`,
 * `messages`, `system`, and the always-safe-to-drop `metadata`/`cache_control` are
 * handled explicitly by the translators and are NOT listed here.
 */
export const UNSUPPORTED_REQUEST_FIELDS: readonly string[] = [
  'n',
  'logprobs',
  'top_logprobs',
  'response_format',
  'seed',
  'logit_bias',
  'audio',
  'modalities',
  'thinking', // Anthropic extended thinking
  'reasoning', // OpenAI reasoning
  'reasoning_effort',
];

/** Throw if the request carries any field from {@link UNSUPPORTED_REQUEST_FIELDS}. */
export function assertNoUnsupportedRequestFields(req: Record<string, unknown>): void {
  for (const field of UNSUPPORTED_REQUEST_FIELDS) {
    if (req[field] !== undefined && req[field] !== null) {
      rejectUnsupported(`request field "${field}" is not supported by the translation proxy`);
    }
  }
}

/** Map an OpenAI `finish_reason` to an Anthropic `stop_reason`. */
export function finishReasonToStopReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'end_turn';
    case null:
    case undefined:
      return null;
    default:
      return 'end_turn';
  }
}

/** Map an Anthropic `stop_reason` to an OpenAI `finish_reason`. */
export function stopReasonToFinishReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case null:
    case undefined:
      return null;
    default:
      return 'stop';
  }
}
