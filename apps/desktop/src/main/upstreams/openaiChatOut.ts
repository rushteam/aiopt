// Upstream driver events → OpenAI Chat Completions output (stream chunks or one completion).
//
// The proxy's driver path always produces OpenAI Chat output and then feeds it through the
// route's existing direction transforms, so Anthropic / Responses clients reach a driver via
// the same translators every other OpenAI-format provider uses.
//
// Pure: unit-tested in upstreams/__tests__/openaiChatOut.test.ts.

import { randomBytes } from 'node:crypto';
import type { SseEvent } from '../proxy/translate/streaming';
import type { UpstreamEvent, UpstreamFailure, UpstreamUsage } from './types';

export interface CompletionIdentity {
  id: string;
  created: number;
  model: string;
}

export function newCompletionIdentity(model: string): CompletionIdentity {
  return {
    id: 'chatcmpl-' + randomBytes(12).toString('hex'),
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

/** A stateful mapper from one Run's events to OpenAI `chat.completion.chunk` SSE events. */
export function createChunkMapper(ident: CompletionIdentity): {
  map(event: UpstreamEvent): SseEvent[];
  done(): SseEvent[];
} {
  let began = false;
  const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}): SseEvent => ({
    data: JSON.stringify({
      id: ident.id,
      object: 'chat.completion.chunk',
      created: ident.created,
      model: ident.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    }),
  });
  const head = (): SseEvent[] => {
    if (began) return [];
    began = true;
    return [chunk({ role: 'assistant', content: '' })];
  };
  return {
    map(event) {
      if ('text' in event) return [...head(), chunk({ content: event.text })];
      if ('reasoning' in event) return [...head(), chunk({ reasoning_content: event.reasoning })];
      if ('tool' in event) {
        const t = event.tool;
        return [
          ...head(),
          chunk({
            tool_calls: [{ index: t.index, id: t.id, type: 'function', function: { name: t.name, arguments: t.args } }],
          }),
        ];
      }
      if ('stop' in event) return [...head(), chunk({}, event.stop, { usage: event.usage })];
      return [];
    },
    done() {
      return [...head(), { data: '[DONE]' }];
    },
  };
}

/** Collect one Run's events into a non-streaming `chat.completion` (or its failure). */
export async function collectCompletion(
  events: AsyncIterable<UpstreamEvent>,
  ident: CompletionIdentity,
): Promise<{ completion: Record<string, unknown> } | { error: UpstreamFailure }> {
  const message: Record<string, unknown> = { role: 'assistant', content: '' };
  let content = '';
  let reasoning = '';
  const calls: unknown[] = [];
  let stop = 'stop';
  let usage: UpstreamUsage | undefined;
  for await (const e of events) {
    if ('error' in e) return { error: e.error };
    if ('text' in e) content += e.text;
    else if ('reasoning' in e) reasoning += e.reasoning;
    else if ('tool' in e) {
      calls.push({ id: e.tool.id, type: 'function', function: { name: e.tool.name, arguments: e.tool.args } });
    } else if ('stop' in e) {
      stop = e.stop;
      usage = e.usage;
    }
  }
  message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.length) message.tool_calls = calls;
  return {
    completion: {
      id: ident.id,
      object: 'chat.completion',
      created: ident.created,
      model: ident.model,
      choices: [{ index: 0, message, finish_reason: stop }],
      ...(usage ? { usage } : {}),
    },
  };
}

/**
 * The key-free message a client sees for an upstream failure. The upstream's own words stay
 * main-side (an upstream body may echo anything); the status picks a generic line.
 */
export function clientMessage(status: number): string {
  switch (status) {
    case 401:
      return 'the provider rejected the sign-in (sign in again)';
    case 403:
      return 'the provider refused this request for the account';
    case 429:
      return 'the provider usage limit was reached';
    case 400:
      return 'the provider rejected the request';
    case 410:
      return 'the request was cancelled';
    case 503:
      return 'the provider is unavailable';
    default:
      return `the provider returned status ${status}`;
  }
}
