// Anthropic Messages / OpenAI Chat Completions → Gemini generateContent transforms (pure).
//
// Used by the routes where an agent speaking Anthropic (claude) or Chat Completions
// (opencode, …) is bound to a provider that only serves the Gemini API. The REQUEST leg
// lowers the client body to a `generateContent` body; the RESPONSE and STREAM legs lift the
// Gemini reply back into the client's dialect. Gemini is never an inbound dialect here.
//
// Wire notes:
//   - The model is in the URL, not the body (see upstream.geminiOutboundUrl).
//   - Streaming uses `:streamGenerateContent?alt=sse`: every `data:` frame is a complete
//     GenerateContentResponse holding only the NEW parts. There is no `[DONE]`; the last
//     frame carries `finishReason`, and the transforms also expose `flush()` so a stream
//     that ends without one still closes cleanly for the client.
//   - A `functionResponse` must name its function, while Anthropic / OpenAI tool results
//     only carry the call id, so names are recovered from the earlier tool calls.
//   - Gemini 3 models attach a `thoughtSignature` to function calls and require it back on
//     the next turn. The proxy is stateless, so the signature rides inside the tool-call id
//     the client echoes ({@link encodeCallId}); nothing is stored main-side.
//   - Gemini accepts only an OpenAPI subset of JSON Schema for tool parameters, so schemas
//     are reduced to that subset ({@link toGeminiSchema}).
//
// No I/O, no Electron.

import { randomUUID } from 'node:crypto';
import { anthropicFrame, openAiFrame, type SseEvent } from './streaming';
import {
  assertNoUnsupportedRequestFields,
  rejectUnsupported,
  type AnthropicContentBlock,
  type AnthropicRequest,
  type AnthropicResponse,
  type OpenAiRequest,
  type OpenAiResponse,
  type OpenAiToolCall,
} from './types';
import { anthropicImageToUrl, openaiImageUrl, urlToGeminiInline } from './images';

// --- Gemini wire shapes (partial: only what the proxy maps) -------------------

export interface GeminiFunctionCall {
  name: string;
  args?: Record<string, unknown>;
  id?: string;
}
export interface GeminiPart {
  text?: string;
  /** True on a reasoning-summary part; never forwarded as answer text. */
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  [key: string]: unknown;
}
export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}
export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  tools?: { functionDeclarations: { name: string; description?: string; parameters?: unknown }[] }[];
  toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] } };
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
}
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}
export interface GeminiResponse {
  candidates?: { content?: { role?: string; parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  responseId?: string;
}

// --- shared helpers ---------------------------------------------------------

/** Separator between a generated call id and an embedded thought signature. */
const SIGNATURE_MARK = '__gsig_';
/** Signatures beyond this length are dropped rather than bloating every later request. */
const MAX_SIGNATURE_LENGTH = 8192;

/** A tool-call id for the client; carries the Gemini thought signature when there is one. */
export function encodeCallId(signature: string | undefined): string {
  const base = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  if (typeof signature !== 'string' || signature === '' || signature.length > MAX_SIGNATURE_LENGTH) return base;
  return `${base}${SIGNATURE_MARK}${signature}`;
}

/** Recover the thought signature a call id carries (undefined when it carries none). */
export function signatureFromCallId(id: string | undefined): string | undefined {
  if (typeof id !== 'string') return undefined;
  const at = id.indexOf(SIGNATURE_MARK);
  if (at === -1) return undefined;
  const sig = id.slice(at + SIGNATURE_MARK.length);
  return sig === '' ? undefined : sig;
}

/** Gemini `args` / `response` must be JSON objects; wrap anything else. */
function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function parseArguments(args: string | undefined): Record<string, unknown> {
  if (!args) return {};
  try {
    return asObject(JSON.parse(args));
  } catch {
    return {};
  }
}

/** The schema keys Gemini's OpenAPI-subset `Schema` accepts. */
const SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'items',
  'minItems',
  'maxItems',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'anyOf',
  'default',
  'propertyOrdering',
]);

/**
 * Reduce a JSON Schema to the subset Gemini accepts: unknown keywords (`$schema`,
 * `additionalProperties`, `exclusiveMinimum`, …) are dropped, `const` becomes a one-value
 * `enum`, and a `type` array with `"null"` becomes `type` + `nullable`. Bounded depth.
 */
export function toGeminiSchema(schema: unknown, depth = 0): unknown {
  if (depth > 24 || typeof schema !== 'object' || schema === null) return schema;
  if (Array.isArray(schema)) return schema.map((s) => toGeminiSchema(s, depth + 1));
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (!SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        props[name] = toGeminiSchema(sub, depth + 1);
      }
      out.properties = props;
    } else if (key === 'items' || key === 'anyOf') {
      out[key] = toGeminiSchema(value, depth + 1);
    } else if (key === 'type' && Array.isArray(value)) {
      const types = value.filter((t) => t !== 'null');
      if (types.length !== value.length) out.nullable = true;
      if (types.length > 0) out.type = types[0];
    } else {
      out[key] = value;
    }
  }
  if (src.const !== undefined && out.enum === undefined) out.enum = [src.const];
  // Gemini enums are string-only.
  if (Array.isArray(out.enum)) out.enum = out.enum.map((v) => String(v));
  return out;
}

/** Gemini `finishReason` → Anthropic `stop_reason`. */
function geminiToStopReason(reason: string | undefined, sawToolCall: boolean): string {
  if (sawToolCall) return 'tool_use';
  return reason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
}

/** Gemini `finishReason` → OpenAI `finish_reason`. */
function geminiToFinishReason(reason: string | undefined, sawToolCall: boolean): string {
  if (sawToolCall) return 'tool_calls';
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function inputTokens(u: GeminiUsageMetadata | undefined): number {
  return Number.isFinite(u?.promptTokenCount) ? (u!.promptTokenCount as number) : 0;
}
/** Output = answer tokens + reasoning tokens (both are billed as output). */
function outputTokens(u: GeminiUsageMetadata | undefined): number {
  const c = Number.isFinite(u?.candidatesTokenCount) ? (u!.candidatesTokenCount as number) : 0;
  const t = Number.isFinite(u?.thoughtsTokenCount) ? (u!.thoughtsTokenCount as number) : 0;
  return c + t;
}

/** The answer parts of the first candidate (reasoning-summary parts dropped). */
function answerParts(resp: GeminiResponse): GeminiPart[] {
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((p) => p.thought !== true);
}

function functionCallPart(name: string, args: Record<string, unknown>, callId: string): GeminiPart {
  const part: GeminiPart = { functionCall: { name, args } };
  const sig = signatureFromCallId(callId);
  if (sig) part.thoughtSignature = sig;
  return part;
}

/** Append parts to the last content when it has the same role (Gemini wants alternation). */
function pushContent(contents: GeminiContent[], role: 'user' | 'model', parts: GeminiPart[]): void {
  if (parts.length === 0) return;
  const last = contents[contents.length - 1];
  if (last && last.role === role) last.parts.push(...parts);
  else contents.push({ role, parts });
}

function generationConfig(opts: {
  maxTokens?: unknown;
  temperature?: unknown;
  topP?: unknown;
  stop?: unknown;
}): GeminiRequest['generationConfig'] | undefined {
  const cfg: NonNullable<GeminiRequest['generationConfig']> = {};
  if (typeof opts.maxTokens === 'number') cfg.maxOutputTokens = opts.maxTokens;
  if (typeof opts.temperature === 'number') cfg.temperature = opts.temperature;
  if (typeof opts.topP === 'number') cfg.topP = opts.topP;
  if (typeof opts.stop === 'string') cfg.stopSequences = [opts.stop];
  else if (Array.isArray(opts.stop) && opts.stop.length > 0) cfg.stopSequences = opts.stop.map(String);
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

// --- Anthropic → Gemini -----------------------------------------------------

function anthropicText(blocks: AnthropicContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('');
}

function anthropicToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return anthropicText(content as AnthropicContentBlock[]);
  return JSON.stringify(content ?? '');
}

/** Translate an Anthropic Messages request into a Gemini generateContent body. */
export function requestAnthropicToGemini(req: AnthropicRequest): GeminiRequest {
  assertNoUnsupportedRequestFields(req);
  const contents: GeminiContent[] = [];
  const nameById = new Map<string, string>();

  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      if (msg.content !== '') pushContent(contents, msg.role === 'assistant' ? 'model' : 'user', [{ text: msg.content }]);
      continue;
    }
    const parts: GeminiPart[] = [];
    for (const block of msg.content) {
      switch (block.type) {
        case 'text': {
          const text = (block as { text?: unknown }).text;
          if (typeof text === 'string' && text !== '') parts.push({ text });
          break;
        }
        case 'tool_use': {
          const b = block as { id: string; name: string; input: unknown };
          nameById.set(b.id, b.name);
          parts.push(functionCallPart(b.name, asObject(b.input ?? {}), b.id));
          break;
        }
        case 'tool_result': {
          const b = block as { tool_use_id: string; content: unknown; is_error?: boolean };
          const name = nameById.get(b.tool_use_id) ?? 'tool';
          const text = anthropicToolResultText(b.content);
          parts.push({
            functionResponse: { name, response: b.is_error === true ? { error: text } : { content: text } },
          });
          break;
        }
        case 'image':
          if (msg.role === 'assistant') {
            rejectUnsupported('an image on an assistant turn is not supported by the translation proxy');
          }
          parts.push(urlToGeminiInline(anthropicImageToUrl(block)));
          break;
        // Prior-turn reasoning cannot be replayed to Gemini; dropping it is lossless for
        // the answer (the signature for tool calls rides in the call id instead).
        case 'thinking':
        case 'redacted_thinking':
          break;
        default:
          rejectUnsupported(`Anthropic content block "${block.type}" is not supported by the translation proxy`);
      }
    }
    pushContent(contents, msg.role === 'assistant' ? 'model' : 'user', parts);
  }

  const out: GeminiRequest = { contents };
  if (req.system !== undefined) {
    const text = typeof req.system === 'string' ? req.system : anthropicText(req.system);
    if (text !== '') out.systemInstruction = { parts: [{ text }] };
  }
  if (req.tools && req.tools.length > 0) {
    out.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: toGeminiSchema(t.input_schema),
        })),
      },
    ];
  }
  if (req.tool_choice) {
    switch (req.tool_choice.type) {
      case 'auto':
        out.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
        break;
      case 'any':
        out.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
        break;
      case 'tool':
        out.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [req.tool_choice.name] } };
        break;
    }
  }
  const cfg = generationConfig({
    maxTokens: req.max_tokens,
    temperature: req.temperature,
    topP: req.top_p,
    stop: req.stop_sequences,
  });
  if (cfg) out.generationConfig = cfg;
  return out;
}

/** Translate a non-streaming Gemini response into an Anthropic Messages response. */
export function responseGeminiToAnthropic(resp: GeminiResponse, modelId: string): AnthropicResponse {
  const content: AnthropicContentBlock[] = [];
  let sawToolCall = false;
  for (const part of answerParts(resp)) {
    if (typeof part.text === 'string' && part.text !== '') {
      const last = content[content.length - 1];
      if (last && last.type === 'text') (last as { text: string }).text += part.text;
      else content.push({ type: 'text', text: part.text });
    } else if (part.functionCall) {
      sawToolCall = true;
      content.push({
        type: 'tool_use',
        id: encodeCallId(part.thoughtSignature),
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    }
  }
  return {
    id: `msg_${resp.responseId ?? randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: resp.modelVersion ?? modelId,
    content,
    stop_reason: geminiToStopReason(resp.candidates?.[0]?.finishReason, sawToolCall),
    stop_sequence: null,
    usage: { input_tokens: inputTokens(resp.usageMetadata), output_tokens: outputTokens(resp.usageMetadata) },
  };
}

/** A stream transform plus an end-of-stream hook (Gemini streams have no terminator). */
export type FlushableStream = ((event: SseEvent) => string[]) & { flush: () => string[] };

function parseChunk(event: SseEvent): GeminiResponse | null {
  const data = event.data.trim();
  if (data === '' || data === '[DONE]') return null;
  try {
    return JSON.parse(data) as GeminiResponse;
  } catch {
    return null;
  }
}

/** Stateful transformer: Gemini SSE chunks → Anthropic SSE events. */
export function createGeminiToAnthropicStream(modelId = 'unknown'): FlushableStream {
  const messageId = `msg_${randomUUID()}`;
  let started = false;
  let finished = false;
  let textOpen = false;
  let nextIndex = 0;
  let textIndex = -1;
  let sawToolCall = false;
  let usage: GeminiUsageMetadata | undefined;

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
          model: modelId,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens(usage), output_tokens: 0 },
        },
      }),
    );
  }

  function closeText(frames: string[]): void {
    if (!textOpen) return;
    frames.push(anthropicFrame('content_block_stop', { type: 'content_block_stop', index: textIndex }));
    textOpen = false;
  }

  function finish(frames: string[], reason: string | undefined): void {
    if (finished) return;
    start(frames);
    closeText(frames);
    frames.push(
      anthropicFrame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: geminiToStopReason(reason, sawToolCall), stop_sequence: null },
        usage: { input_tokens: inputTokens(usage), output_tokens: outputTokens(usage) },
      }),
    );
    frames.push(anthropicFrame('message_stop', { type: 'message_stop' }));
    finished = true;
  }

  const transform = ((event: SseEvent): string[] => {
    const chunk = parseChunk(event);
    if (!chunk || finished) return [];
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    const frames: string[] = [];
    start(frames);
    for (const part of answerParts(chunk)) {
      if (typeof part.text === 'string' && part.text !== '') {
        if (!textOpen) {
          textIndex = nextIndex++;
          textOpen = true;
          frames.push(
            anthropicFrame('content_block_start', {
              type: 'content_block_start',
              index: textIndex,
              content_block: { type: 'text', text: '' },
            }),
          );
        }
        frames.push(
          anthropicFrame('content_block_delta', {
            type: 'content_block_delta',
            index: textIndex,
            delta: { type: 'text_delta', text: part.text },
          }),
        );
      } else if (part.functionCall) {
        closeText(frames);
        sawToolCall = true;
        const index = nextIndex++;
        frames.push(
          anthropicFrame('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: encodeCallId(part.thoughtSignature), name: part.functionCall.name, input: {} },
          }),
          anthropicFrame('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.functionCall.args ?? {}) },
          }),
          anthropicFrame('content_block_stop', { type: 'content_block_stop', index }),
        );
      }
    }
    const reason = chunk.candidates?.[0]?.finishReason;
    if (reason) finish(frames, reason);
    return frames;
  }) as FlushableStream;

  transform.flush = () => {
    const frames: string[] = [];
    finish(frames, undefined);
    return frames;
  };
  return transform;
}

// --- OpenAI Chat → Gemini ---------------------------------------------------

/** A user turn's mixed text + image parts → Gemini parts, in order. */
function userParts(content: unknown[]): GeminiPart[] {
  const parts: GeminiPart[] = [];
  for (const part of content) {
    const p = part as { type?: unknown; text?: unknown };
    if (p?.type === 'image_url') parts.push(urlToGeminiInline(openaiImageUrl(p)));
    else if (p?.type === 'text' && typeof p.text === 'string') {
      if (p.text !== '') parts.push({ text: p.text });
    } else rejectUnsupported(`OpenAI content part "${String(p?.type)}" is not supported by the translation proxy`);
  }
  return parts;
}

/**
 * Message content as text: a string, or an array of text parts (anything else refused). A
 * user turn holding an image returns '' here; its parts are mapped by {@link userParts}.
 */
function openAiText(content: unknown, role?: string): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    if (role === 'user' && content.some((p) => (p as { type?: unknown })?.type === 'image_url')) return '';
    let text = '';
    for (const part of content) {
      const p = part as { type?: unknown; text?: unknown };
      if (p?.type !== 'text' || typeof p.text !== 'string') {
        rejectUnsupported(`OpenAI content part "${String(p?.type)}" is not supported by the translation proxy`);
      }
      text += p.text;
    }
    return text;
  }
  return rejectUnsupported('OpenAI message content is not supported by the translation proxy');
}

/** Translate an OpenAI Chat Completions request into a Gemini generateContent body. */
export function requestOpenaiToGemini(req: OpenAiRequest): GeminiRequest {
  assertNoUnsupportedRequestFields(req);
  const contents: GeminiContent[] = [];
  const systemParts: string[] = [];
  const nameById = new Map<string, string>();

  for (const msg of req.messages) {
    const text = openAiText(msg.content as unknown, msg.role);
    switch (msg.role) {
      case 'system':
        if (text !== '') systemParts.push(text);
        break;
      case 'user':
        if (text !== '') pushContent(contents, 'user', [{ text }]);
        else if (Array.isArray(msg.content)) pushContent(contents, 'user', userParts(msg.content));
        break;
      case 'assistant': {
        const parts: GeminiPart[] = [];
        if (text !== '') parts.push({ text });
        for (const tc of msg.tool_calls ?? []) {
          nameById.set(tc.id, tc.function.name);
          parts.push(functionCallPart(tc.function.name, parseArguments(tc.function.arguments), tc.id));
        }
        pushContent(contents, 'model', parts);
        break;
      }
      case 'tool': {
        const name = nameById.get(msg.tool_call_id ?? '') ?? msg.name ?? 'tool';
        pushContent(contents, 'user', [{ functionResponse: { name, response: { content: text } } }]);
        break;
      }
    }
  }

  const out: GeminiRequest = { contents };
  if (systemParts.length > 0) out.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
  if (req.tools && req.tools.length > 0) {
    out.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: toGeminiSchema(t.function.parameters ?? { type: 'object', properties: {} }),
        })),
      },
    ];
  }
  if (typeof req.tool_choice === 'string') {
    const mode = req.tool_choice === 'required' ? 'ANY' : req.tool_choice === 'none' ? 'NONE' : 'AUTO';
    out.toolConfig = { functionCallingConfig: { mode } };
  } else if (req.tool_choice && typeof req.tool_choice === 'object') {
    const fn = (req.tool_choice as { function?: { name?: string } }).function;
    if (fn?.name) out.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [fn.name] } };
  }
  const maxTokens = typeof req.max_tokens === 'number' ? req.max_tokens : req.max_completion_tokens;
  const cfg = generationConfig({ maxTokens, temperature: req.temperature, topP: req.top_p, stop: req.stop });
  if (cfg) out.generationConfig = cfg;
  return out;
}

/** Translate a non-streaming Gemini response into an OpenAI Chat completion. */
export function responseGeminiToOpenai(resp: GeminiResponse, modelId: string): OpenAiResponse {
  let text = '';
  const toolCalls: OpenAiToolCall[] = [];
  for (const part of answerParts(resp)) {
    if (typeof part.text === 'string') text += part.text;
    else if (part.functionCall) {
      toolCalls.push({
        id: encodeCallId(part.thoughtSignature),
        type: 'function',
        function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
      });
    }
  }
  const message: OpenAiResponse['choices'][number]['message'] = { role: 'assistant', content: text === '' ? null : text };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const input = inputTokens(resp.usageMetadata);
  const output = outputTokens(resp.usageMetadata);
  return {
    id: `chatcmpl-${resp.responseId ?? randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resp.modelVersion ?? modelId,
    choices: [
      { index: 0, message, finish_reason: geminiToFinishReason(resp.candidates?.[0]?.finishReason, toolCalls.length > 0) },
    ],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  };
}

/** Stateful transformer: Gemini SSE chunks → OpenAI Chat Completions chunk frames. */
export function createGeminiToOpenaiStream(modelId = 'unknown'): FlushableStream {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let sentRole = false;
  let finished = false;
  let nextToolIndex = 0;
  let usage: GeminiUsageMetadata | undefined;

  function chunk(delta: Record<string, unknown>, finishReason: string | null = null, withUsage = false): string {
    const body: Record<string, unknown> = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (withUsage) {
      const input = inputTokens(usage);
      const output = outputTokens(usage);
      body.usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
    }
    return openAiFrame(JSON.stringify(body));
  }

  function role(frames: string[]): void {
    if (sentRole) return;
    sentRole = true;
    frames.push(chunk({ role: 'assistant', content: '' }));
  }

  function finish(frames: string[], reason: string | undefined): void {
    if (finished) return;
    role(frames);
    frames.push(chunk({}, geminiToFinishReason(reason, nextToolIndex > 0), true));
    frames.push(openAiFrame('[DONE]'));
    finished = true;
  }

  const transform = ((event: SseEvent): string[] => {
    const c = parseChunk(event);
    if (!c || finished) return [];
    if (c.usageMetadata) usage = c.usageMetadata;
    const frames: string[] = [];
    role(frames);
    for (const part of answerParts(c)) {
      if (typeof part.text === 'string' && part.text !== '') {
        frames.push(chunk({ content: part.text }));
      } else if (part.functionCall) {
        const index = nextToolIndex++;
        frames.push(
          chunk({
            tool_calls: [
              {
                index,
                id: encodeCallId(part.thoughtSignature),
                type: 'function',
                function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
              },
            ],
          }),
        );
      }
    }
    const reason = c.candidates?.[0]?.finishReason;
    if (reason) finish(frames, reason);
    return frames;
  }) as FlushableStream;

  transform.flush = () => {
    const frames: string[] = [];
    finish(frames, undefined);
    return frames;
  };
  return transform;
}
