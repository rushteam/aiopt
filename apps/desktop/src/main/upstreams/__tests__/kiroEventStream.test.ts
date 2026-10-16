import { describe, expect, it } from 'vitest';
import { kiroEvents, readFrames, ThinkSplitter, type KiroFrame } from '../kiro/eventStream';
import type { UpstreamEvent } from '../types';

/** One AWS event-stream frame with string headers (CRCs left zero; they are not checked). */
function frame(headers: Record<string, string>, payload: unknown): Uint8Array {
  const enc = new TextEncoder();
  const hs: number[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const kb = enc.encode(k);
    const vb = enc.encode(v);
    hs.push(kb.length, ...kb, 7, vb.length >> 8, vb.length & 0xff, ...vb);
  }
  const body = enc.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const total = 12 + hs.length + body.length + 4;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, total);
  v.setUint32(4, hs.length);
  out.set(hs, 12);
  out.set(body, 12 + hs.length);
  return out;
}
const ev = (type: string, payload: unknown) => frame({ ':message-type': 'event', ':event-type': type }, payload);

function stream(bytes: Uint8Array, chunk = 7): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
      c.close();
    },
  });
}
const concat = (...fs: Uint8Array[]) => {
  const out = new Uint8Array(fs.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of fs) {
    out.set(f, o);
    o += f.length;
  }
  return out;
};
async function all(it: AsyncIterable<UpstreamEvent>): Promise<UpstreamEvent[]> {
  const out: UpstreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const opts = { thinking: false, names: new Map<string, string>(), contextWindow: 0 };

describe('Kiro event stream', () => {
  it('reads frames split across chunks', async () => {
    const frames: KiroFrame[] = [];
    for await (const f of readFrames(stream(concat(ev('a', { x: 1 }), ev('b', { y: 2 }))))) frames.push(f);
    expect(frames.map((f) => f.headers[':event-type'])).toEqual(['a', 'b']);
    expect(JSON.parse(new TextDecoder().decode(frames[1]!.payload))).toEqual({ y: 2 });
  });

  it('turns text, tool calls and usage into driver events', async () => {
    const bytes = concat(
      ev('assistantResponseEvent', { content: 'Hel' }),
      ev('assistantResponseEvent', { content: 'lo' }),
      ev('toolUseEvent', { toolUseId: 't1', name: 'mcp_x_abc', input: '{"a":' }),
      ev('toolUseEvent', { toolUseId: 't1', input: '1}' }),
      ev('toolUseEvent', { toolUseId: 't1', stop: true }),
      ev('metadataEvent', { tokenUsage: { uncachedInputTokens: 10, outputTokens: 5, cacheReadInputTokens: 90 } }),
    );
    const out = await all(kiroEvents(readFrames(stream(bytes)), { ...opts, names: new Map([['mcp_x_abc', 'mcp.x']]) }));
    expect(out).toEqual([
      { text: 'Hel' },
      { text: 'lo' },
      { tool: { index: 0, id: 't1', name: 'mcp.x', args: '{"a":1}' } },
      { stop: 'tool_calls', usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 90 } } },
    ]);
  });

  it('splits a leading <thinking> out as reasoning and estimates usage', async () => {
    const bytes = concat(
      ev('assistantResponseEvent', { content: '<thin' }),
      ev('assistantResponseEvent', { content: 'king>\nhmm</thi' }),
      ev('assistantResponseEvent', { content: 'nking>\n\nAnswer' }),
      ev('contextUsageEvent', { contextUsagePercentage: 10 }),
    );
    const out = await all(kiroEvents(readFrames(stream(bytes)), { ...opts, thinking: true, contextWindow: 1000 }));
    expect(out.slice(0, 2)).toEqual([{ reasoning: 'hmm' }, { text: 'Answer' }]);
    expect(out[2]).toMatchObject({ stop: 'stop', usage: { prompt_tokens: 100 } });
  });

  it('ends with an error on an exception frame', async () => {
    const bytes = concat(
      ev('assistantResponseEvent', { content: 'x' }),
      frame({ ':message-type': 'exception', ':exception-type': 'ThrottlingException' }, { message: 'slow down' }),
    );
    const out = await all(kiroEvents(readFrames(stream(bytes)), opts));
    expect(out.at(-1)).toEqual({ error: { status: 429, message: 'ThrottlingException' } });
  });

  it('reports a cut-off stream', async () => {
    const f = ev('assistantResponseEvent', { content: 'x' });
    const out = await all(kiroEvents(readFrames(stream(f.slice(0, f.length - 3))), opts));
    expect(out.at(-1)).toEqual({ error: { status: 502, message: 'the answer broke off' } });
  });

  it('holds back a partial tag', () => {
    const t = new ThinkSplitter();
    expect(t.feed('<think')).toEqual([]);
    expect(t.feed('ing>a</thin')).toEqual([{ think: 'a' }]);
    expect(t.feed('king>b')).toEqual([{ text: 'b' }]);
    expect(new ThinkSplitter().feed('plain')).toEqual([{ text: 'plain' }]);
  });
});
