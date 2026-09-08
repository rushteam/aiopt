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

import type { ApiFormat } from '../../shared/aiProviders';
import type { SseEvent } from './translate/streaming';

export interface UsageCounts {
  inputTokens: number;
  outputTokens: number;
}

const ZERO: UsageCounts = { inputTokens: 0, outputTokens: 0 };

function num(v: unknown): number {
  return Number.isFinite(v) ? (v as number) : 0;
}

/** Read token counts from a non-streaming upstream body by its (outbound) format. */
export function readResponseUsage(outboundFormat: ApiFormat, json: Record<string, unknown>): UsageCounts {
  const usage = json.usage;
  if (!usage || typeof usage !== 'object') return { ...ZERO };
  const u = usage as Record<string, unknown>;
  if (outboundFormat === 'anthropic') {
    return { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) };
  }
  // openai (Chat Completions) — also the shape gemini/openai-responses upstreams echo.
  return { inputTokens: num(u.prompt_tokens), outputTokens: num(u.completion_tokens) };
}

export interface UsageSniffer {
  /** Feed one upstream SSE event; cheap, no allocation on the common path. */
  observe(event: SseEvent): void;
  /** Best-effort token counts accumulated so far. */
  result(): UsageCounts;
}

/**
 * Stateful sniffer for a streamed upstream, decoupled from the response transform (it only
 * reads, never rewrites). Anthropic splits usage across `message_start` (input) and
 * `message_delta` (running output); OpenAI Chat emits `usage` only on the final chunk, and
 * only when the request carried `stream_options.include_usage:true` (the proxy injects it).
 */
export function createUsageSniffer(outboundFormat: ApiFormat): UsageSniffer {
  let inputTokens = 0;
  let outputTokens = 0;

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
          const msg = (payload.message ?? {}) as { usage?: { input_tokens?: unknown; output_tokens?: unknown } };
          if (msg.usage) {
            inputTokens = num(msg.usage.input_tokens);
            outputTokens = num(msg.usage.output_tokens);
          }
        } else if (event.event === 'message_delta') {
          const usage = (payload.usage ?? {}) as { output_tokens?: unknown };
          if (usage.output_tokens !== undefined) outputTokens = num(usage.output_tokens);
        }
        return;
      }

      // openai / gemini / openai-responses: the terminal chunk carries a full usage object.
      const usage = payload.usage;
      if (usage && typeof usage === 'object') {
        const u = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
        inputTokens = num(u.prompt_tokens);
        outputTokens = num(u.completion_tokens);
      }
    },

    result() {
      return { inputTokens, outputTokens };
    },
  };
}
