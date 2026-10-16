// Usage sniffer — pull token counts out of an upstream reply, by outbound format.
//
// Pure and Electron-free (unit tested). Two entry points, matching the proxy's two
// completion paths:
//   - readResponseUsage(format, json)  — non-streaming: read `usage` off the parsed body.
//   - createUsageSniffer(format)        — streaming: `observe` each upstream SSE event and
//                                         read `result()` at stream end.
//
// It reads ONLY the numeric `usage` fields native to each format. It never inspects
// content, tokens-as-text, keys, or the reasoning-bridge payload — consistent with the
// proxy rule that token counts are the only usage data that may be recorded.
//
// The counts are normalized to one shape whatever the dialect:
//   - inputTokens       prompt tokens NOT served from (or written to) the cache;
//   - cacheReadTokens   prompt tokens served from the cache;
//   - cacheWriteTokens  prompt tokens written to the cache (Anthropic only reports this);
//   - outputTokens      everything generated, reasoning included (it is billed as output);
//   - reasoningTokens   the reasoning part of outputTokens (a subset, not added again).
// OpenAI Chat / Responses and Gemini count the cached prompt INSIDE their prompt total, so
// it is subtracted; Anthropic already reports `input_tokens` without the cache.

import type { ApiFormat } from '../../shared/aiProviders';
import type { SseEvent } from './translate/streaming';

export interface UsageCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export function zeroUsage(): UsageCounts {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

function num(v: unknown): number {
  return Number.isFinite(v) ? (v as number) : 0;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/** Gemini `usageMetadata`: the prompt count includes cached tokens; output = answer + thoughts. */
function geminiCounts(meta: unknown): UsageCounts | null {
  const m = rec(meta);
  if (!m) return null;
  const cached = num(m.cachedContentTokenCount);
  const thoughts = num(m.thoughtsTokenCount);
  return {
    inputTokens: Math.max(0, num(m.promptTokenCount) - cached),
    outputTokens: num(m.candidatesTokenCount) + thoughts,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens: thoughts,
  };
}

/** Anthropic Messages `usage`: `input_tokens` already excludes cache reads and writes. */
function anthropicCounts(u: Record<string, unknown>): UsageCounts {
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    reasoningTokens: 0,
  };
}

/** OpenAI Responses `usage`: `input_tokens` includes `input_tokens_details.cached_tokens`. */
function responsesCounts(u: Record<string, unknown>): UsageCounts {
  const cached = num(rec(u.input_tokens_details)?.cached_tokens);
  return {
    inputTokens: Math.max(0, num(u.input_tokens) - cached),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens: num(rec(u.output_tokens_details)?.reasoning_tokens),
  };
}

/**
 * OpenAI Chat `usage`: `prompt_tokens` includes the cached prompt. The cached count is
 * `prompt_tokens_details.cached_tokens` (OpenAI and most compatibles) or DeepSeek's
 * `prompt_cache_hit_tokens`; some compatibles also report `cache_creation_input_tokens`.
 */
function chatCounts(u: Record<string, unknown>): UsageCounts {
  const details = rec(u.prompt_tokens_details);
  const cached = num(details?.cached_tokens) || num(u.prompt_cache_hit_tokens);
  const written = num(details?.cache_write_tokens) || num(u.cache_creation_input_tokens);
  return {
    inputTokens: Math.max(0, num(u.prompt_tokens) - cached - written),
    outputTokens: num(u.completion_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: written,
    reasoningTokens: num(rec(u.completion_tokens_details)?.reasoning_tokens),
  };
}

/** Read token counts from a non-streaming upstream body by its (outbound) format. */
export function readResponseUsage(outboundFormat: ApiFormat, json: Record<string, unknown>): UsageCounts {
  if (outboundFormat === 'gemini') return geminiCounts(json.usageMetadata) ?? zeroUsage();
  const u = rec(json.usage);
  if (!u) return zeroUsage();
  if (outboundFormat === 'anthropic') return anthropicCounts(u);
  if (outboundFormat === 'openai-responses') return responsesCounts(u);
  return chatCounts(u);
}

export interface UsageSniffer {
  /** Feed one upstream SSE event; cheap, no allocation on the common path. */
  observe(event: SseEvent): void;
  /** Best-effort token counts accumulated so far. */
  result(): UsageCounts;
}

/**
 * Stateful sniffer for a streamed upstream, decoupled from the response transform (it only
 * reads, never rewrites). Anthropic splits usage across `message_start` (input + cache) and
 * `message_delta` (running output, and on newer APIs the final input/cache too); OpenAI
 * Chat emits `usage` only on the final chunk, and only when the request carried
 * `stream_options.include_usage:true` (the proxy injects it).
 */
export function createUsageSniffer(outboundFormat: ApiFormat): UsageSniffer {
  let counts = zeroUsage();

  function parse(data: string | undefined): Record<string, unknown> | null {
    if (!data || data === '[DONE]') return null;
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  return {
    observe(event) {
      const payload = parse(event.data);
      if (!payload) return;

      if (outboundFormat === 'anthropic') {
        if (event.event === 'message_start') {
          const usage = rec(rec(payload.message)?.usage);
          if (usage) counts = anthropicCounts(usage);
        } else if (event.event === 'message_delta') {
          const usage = rec(payload.usage);
          if (!usage) return;
          // Each field the delta carries is the running total; absent fields keep theirs.
          if (usage.output_tokens !== undefined) counts.outputTokens = num(usage.output_tokens);
          if (usage.input_tokens !== undefined) counts.inputTokens = num(usage.input_tokens);
          if (usage.cache_read_input_tokens !== undefined) counts.cacheReadTokens = num(usage.cache_read_input_tokens);
          if (usage.cache_creation_input_tokens !== undefined) {
            counts.cacheWriteTokens = num(usage.cache_creation_input_tokens);
          }
        }
        return;
      }

      if (outboundFormat === 'openai-responses') {
        // Responses streams usage nested under the `response` object on its terminal
        // `response.completed` (and echoes it on `response.incomplete`).
        const usage = rec(rec(payload.response)?.usage);
        if (usage) counts = responsesCounts(usage);
        return;
      }

      if (outboundFormat === 'gemini') {
        // Each Gemini chunk may carry a running `usageMetadata`; the last one is final.
        const next = geminiCounts(payload.usageMetadata);
        if (next) counts = next;
        return;
      }

      // openai (Chat Completions): the terminal chunk carries a full usage object.
      const usage = rec(payload.usage);
      if (usage) counts = chatCounts(usage);
    },

    result() {
      return { ...counts };
    },
  };
}
