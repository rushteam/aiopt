// OpenAI Chat Completions (an upstream's answer) → upstream driver events.
//
// For drivers whose vendor speaks OpenAI Chat over HTTP but needs its own headers or body
// handling (WorkBuddy, …): the driver POSTs, and this turns the streamed (SSE) or one-shot
// (JSON) answer into the driver contract's events. Tool-call fragments are gathered and
// emitted whole, before the stop, so the chunk mapper sees each call once.
//
// Pure: unit-tested in upstreams/__tests__/openaiChatIn.test.ts.

import { SseDecoder } from '../proxy/translate/streaming';
import type { UpstreamEvent, UpstreamUsage } from './types';

interface ToolAcc {
  id: string;
  name: string;
  args: string;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** An upstream's `usage` as the contract carries it (cache + reasoning details kept). */
export function usageFrom(raw: unknown): UpstreamUsage {
  const u = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  const out: UpstreamUsage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: num(u.total_tokens) || prompt + completion,
  };
  const pd = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const cached = num(pd?.cached_tokens) || num(u.prompt_cache_hit_tokens);
  const write = num(pd?.cache_write_tokens) || num(u.cache_creation_input_tokens);
  if (cached || write) out.prompt_tokens_details = { cached_tokens: cached, ...(write ? { cache_write_tokens: write } : {}) };
  const reasoning = num((u.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens);
  if (reasoning) out.completion_tokens_details = { reasoning_tokens: reasoning };
  return out;
}

/** A stateful reader of one answer's chunks. */
export function createChatChunkReader(): {
  /** One parsed `chat.completion.chunk` (or a whole `chat.completion`). */
  read(chunk: unknown): UpstreamEvent[];
  /** The answer ended: pending tool calls, then the stop. */
  end(): UpstreamEvent[];
} {
  const tools = new Map<number, ToolAcc>();
  let finish: string | null = null;
  let usage: UpstreamUsage | null = null;
  let ended = false;
  const take = (choice: Record<string, unknown>, part: unknown): UpstreamEvent[] => {
    const out: UpstreamEvent[] = [];
    const d = (part && typeof part === 'object' ? part : {}) as Record<string, unknown>;
    const reasoning = typeof d.reasoning_content === 'string' ? d.reasoning_content : typeof d.reasoning === 'string' ? d.reasoning : '';
    if (reasoning) out.push({ reasoning });
    if (typeof d.content === 'string' && d.content) out.push({ text: d.content });
    if (Array.isArray(d.tool_calls)) {
      d.tool_calls.forEach((tc: unknown, i: number) => {
        const t = (tc && typeof tc === 'object' ? tc : {}) as Record<string, unknown>;
        const index = typeof t.index === 'number' ? t.index : i;
        const fn = (t.function && typeof t.function === 'object' ? t.function : {}) as Record<string, unknown>;
        const acc = tools.get(index) ?? { id: '', name: '', args: '' };
        if (typeof t.id === 'string' && t.id) acc.id = t.id;
        if (typeof fn.name === 'string' && fn.name) acc.name = acc.name || fn.name;
        if (typeof fn.arguments === 'string') acc.args += fn.arguments;
        tools.set(index, acc);
      });
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) finish = choice.finish_reason;
    return out;
  };
  return {
    read(chunk) {
      if (!chunk || typeof chunk !== 'object') return [];
      const c = chunk as Record<string, unknown>;
      if (c.usage && typeof c.usage === 'object') usage = usageFrom(c.usage);
      const out: UpstreamEvent[] = [];
      for (const ch of Array.isArray(c.choices) ? c.choices : []) {
        if (!ch || typeof ch !== 'object') continue;
        const choice = ch as Record<string, unknown>;
        out.push(...take(choice, choice.delta ?? choice.message));
      }
      return out;
    },
    end() {
      if (ended) return [];
      ended = true;
      const out: UpstreamEvent[] = [];
      let n = 0;
      for (const [, t] of [...tools.entries()].sort((a, b) => a[0] - b[0])) {
        if (!t.name) continue;
        out.push({ tool: { index: n, id: t.id || `call_${n}`, name: t.name, args: t.args || '{}' } });
        n++;
      }
      const stop = n > 0 || finish === 'tool_calls' ? 'tool_calls' : 'stop';
      out.push({ stop, usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      return out;
    },
  };
}

/** Read an SSE body of `chat.completion.chunk`s as driver events. */
export async function* readChatSse(body: ReadableStream<Uint8Array>): AsyncGenerator<UpstreamEvent> {
  const reader = createChatChunkReader();
  const sse = new SseDecoder();
  const text = new TextDecoder();
  const parse = (data: string): unknown => {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  };
  const stream = body.getReader();
  try {
    for (;;) {
      const { value, done } = await stream.read();
      if (done) break;
      for (const ev of sse.push(text.decode(value, { stream: true }).replace(/\r/g, ''))) {
        if (ev.data === '[DONE]') {
          yield* reader.end();
          return;
        }
        const chunk = parse(ev.data);
        if (chunk && typeof chunk === 'object' && 'error' in chunk && (chunk as { error?: unknown }).error) {
          yield { error: { status: 502, message: 'stream error' } };
          return;
        }
        yield* reader.read(chunk);
      }
    }
    for (const ev of sse.flush()) {
      if (ev.data !== '[DONE]') yield* reader.read(parse(ev.data));
    }
    yield* reader.end();
  } finally {
    stream.releaseLock();
  }
}
