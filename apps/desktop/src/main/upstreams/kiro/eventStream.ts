// Kiro's answer (an AWS event stream) → upstream driver events.
//
// Each frame is: total length (u32), headers length (u32), prelude CRC (u32), the headers,
// the payload, a message CRC (u32). The `:event-type` header names the payload (JSON):
//   assistantResponseEvent  { content }       → text (or thinking, see below)
//   reasoningContentEvent   { text }          → reasoning
//   toolUseEvent            { toolUseId, name, input } → a tool call, its arguments in pieces
//   metadataEvent / messageMetadataEvent      → stopReason, tokenUsage
//   contextUsageEvent       { contextUsagePercentage }
// An `exception` / `error` frame (or an error event type) ends the answer with a failure.
//
// With a thinking budget the model thinks aloud inside a leading <thinking>…</thinking> in
// the text; that is split out as reasoning, however the tags fall across pieces.
//
// Ported from magpie's Kiro plugin (frames / frameHeaders / ThinkParser / events).
// Pure: unit-tested in upstreams/__tests__/kiroEventStream.test.ts.

import type { UpstreamEvent, UpstreamUsage } from '../types';

export interface KiroFrame {
  headers: Record<string, string>;
  payload: Uint8Array;
}

const MAX_FRAME = 16 << 20;

/** The string headers of a frame (other header types are skipped). */
export function frameHeaders(h: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const dec = new TextDecoder();
  const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
  const SIZES: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };
  let i = 0;
  while (i < h.length) {
    const n = h[i]!;
    if (h.length < i + 2 + n) break;
    const name = dec.decode(h.subarray(i + 1, i + 1 + n));
    const type = h[i + 1 + n]!;
    i += 2 + n;
    if (type === 6 || type === 7) {
      if (h.length < i + 2) break;
      const l = v.getUint16(i);
      if (h.length < i + 2 + l) break;
      if (type === 7) out[name] = dec.decode(h.subarray(i + 2, i + 2 + l));
      i += 2 + l;
      continue;
    }
    const size = SIZES[type];
    if (size === undefined || h.length < i + size) break;
    i += size;
  }
  return out;
}

/** The frames of an event stream. Throws on a malformed or cut-off stream. */
export async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<KiroFrame> {
  let buf = new Uint8Array(0);
  const reader = body.getReader();
  try {
    for (;;) {
      while (buf.length >= 12) {
        const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const total = v.getUint32(0);
        const hlen = v.getUint32(4);
        if (total < 16 || total > MAX_FRAME || hlen > total - 16) throw new Error('malformed event stream');
        if (buf.length < total) break;
        const rest = buf.subarray(12, total);
        yield { headers: frameHeaders(rest.subarray(0, hlen)), payload: rest.subarray(hlen, rest.length - 4) };
        buf = buf.slice(total);
      }
      const { value, done } = await reader.read();
      if (done) {
        if (buf.length) throw new Error('unexpected EOF');
        return;
      }
      const n = new Uint8Array(buf.length + value.length);
      n.set(buf);
      n.set(value, buf.length);
      buf = n;
    }
  } finally {
    reader.releaseLock();
  }
}

// ---- <thinking> in the text ------------------------------------------------------------

const OPEN = '<thinking>';
const CLOSE = '</thinking>';

function partialSuffix(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (s.endsWith(tag.slice(0, n))) return n;
  return 0;
}

type Piece = { think: string } | { text: string };

export class ThinkSplitter {
  private state: 0 | 1 | 2 = 0; // 0: not yet known, 1: thinking, 2: text
  private buf = '';
  private said = false;

  feed(s: string): Piece[] {
    this.buf += s;
    const out: Piece[] = [];
    for (;;) {
      if (this.state === 0) {
        const t = this.buf.replace(/^[ \t\r\n]+/, '');
        if (t.startsWith(OPEN)) {
          this.buf = t.slice(OPEN.length);
          this.state = 1;
          continue;
        }
        if (t.length < OPEN.length && OPEN.startsWith(t)) return out;
        this.state = 2;
        continue;
      }
      if (this.state === 1) {
        if (!this.said) {
          this.buf = this.buf.replace(/^[\r\n]+/, '');
          if (!this.buf) return out;
        }
        const i = this.buf.indexOf(CLOSE);
        if (i >= 0) {
          if (i > 0) {
            out.push({ think: this.buf.slice(0, i) });
            this.said = true;
          }
          this.buf = this.buf.slice(i + CLOSE.length).replace(/^[\r\n]+/, '');
          this.state = 2;
          continue;
        }
        const n = this.buf.length - partialSuffix(this.buf, CLOSE);
        if (n > 0) {
          out.push({ think: this.buf.slice(0, n) });
          this.buf = this.buf.slice(n);
          this.said = true;
        }
        return out;
      }
      if (this.buf) out.push({ text: this.buf });
      this.buf = '';
      return out;
    }
  }

  end(): Piece[] {
    if (!this.buf) return [];
    const p: Piece = this.state === 1 ? { think: this.buf } : { text: this.buf };
    this.buf = '';
    if (this.state === 0) this.state = 2;
    return [p];
  }
}

// ---- the answer ------------------------------------------------------------------------

const ERROR_EVENTS = new Set(['error', 'throttlingError', 'validationError', 'serviceUnavailableError', 'internalServerException']);
const QUOTA = /quota|insufficient|exceeded|rate.?limit|usage.?limit|limit.?reached|too many requests|throttl|MONTHLY_REQUEST_COUNT/i;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function exceptionStatus(kind: string, payload: Uint8Array): number {
  const text = new TextDecoder().decode(payload);
  if (QUOTA.test(kind) || QUOTA.test(text)) return 429;
  if (/CONTENT_LENGTH_EXCEEDS_THRESHOLD|input is too long|validation/i.test(kind + text)) return 400;
  if (/INSUFFICIENT_MODEL_CAPACITY|serviceUnavailable/i.test(kind + text)) return 503;
  return 502;
}

export interface KiroAnswerOptions {
  /** Split a leading <thinking>…</thinking> out of the text. */
  thinking: boolean;
  /** Names Kiro was sent under, mapped back to the caller's. */
  names: Map<string, string>;
  /** The model's context window (for an input count from Kiro's "context % used"). */
  contextWindow: number;
}

/** Kiro's event stream as driver events: text, reasoning, whole tool calls, then the stop. */
export async function* kiroEvents(frames: AsyncIterable<KiroFrame>, opts: KiroAnswerOptions): AsyncGenerator<UpstreamEvent> {
  const think = new ThinkSplitter();
  const dec = new TextDecoder();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let pct = 0;
  let said = 0;
  let tools = 0;
  const cur: { open: { id: string; name: string; args: string } | null } = { open: null };
  const pieces = (ps: Piece[]): UpstreamEvent[] => ps.map((p) => ('think' in p ? { reasoning: p.think } : { text: p.text }));
  const closeTool = (): UpstreamEvent[] => {
    const t = cur.open;
    if (!t) return [];
    cur.open = null;
    const name = opts.names.get(t.name) ?? t.name;
    return [{ tool: { index: tools++, id: t.id, name, args: t.args || '{}' } }];
  };
  try {
    for await (const f of frames) {
      const type = f.headers[':message-type'];
      if (type === 'exception' || type === 'error') {
        const kind = f.headers[':exception-type'] || f.headers[':error-code'] || '';
        yield { error: { status: exceptionStatus(kind, f.payload), message: kind || 'exception' } };
        return;
      }
      const kind = f.headers[':event-type'] ?? '';
      if (ERROR_EVENTS.has(kind)) {
        yield { error: { status: exceptionStatus(kind, f.payload), message: kind } };
        return;
      }
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(dec.decode(f.payload)) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!m || typeof m !== 'object') continue;
      if (kind === 'assistantResponseEvent') {
        const text = typeof m.content === 'string' ? m.content : '';
        said += text.length;
        if (!text) continue;
        yield* closeTool();
        if (opts.thinking) yield* pieces(think.feed(text));
        else yield { text };
      } else if (kind === 'reasoningContentEvent') {
        if (typeof m.text === 'string' && m.text) {
          said += m.text.length;
          yield { reasoning: m.text };
        }
      } else if (kind === 'toolUseEvent') {
        const id = typeof m.toolUseId === 'string' ? m.toolUseId : '';
        if (id && id !== cur.open?.id) {
          yield* pieces(think.end()); // the text before a call is all said
          yield* closeTool();
          cur.open = { id, name: typeof m.name === 'string' ? m.name : '', args: '' };
        }
        const t = cur.open;
        if (t && m.input !== undefined && m.input !== null) {
          const piece = typeof m.input === 'string' ? m.input : JSON.stringify(m.input);
          if (piece !== '{}' || typeof m.input === 'string') t.args += piece;
          said += piece.length;
        }
      } else if (kind === 'metadataEvent' || kind === 'messageMetadataEvent') {
        const tu = m.tokenUsage as Record<string, unknown> | undefined;
        if (tu && typeof tu === 'object') {
          usage.input += num(tu.uncachedInputTokens) || num(tu.inputTokens);
          usage.output += num(tu.outputTokens);
          usage.cacheRead += num(tu.cacheReadInputTokens);
          usage.cacheWrite += num(tu.cacheWriteInputTokens);
          if (num(tu.contextUsagePercentage)) pct = num(tu.contextUsagePercentage);
        }
      } else if (kind === 'contextUsageEvent') {
        if (num(m.contextUsagePercentage)) pct = num(m.contextUsagePercentage);
      }
    }
  } catch (e) {
    if ((e as { name?: string } | null)?.name === 'AbortError') throw e;
    yield* pieces(think.end());
    yield { error: { status: 502, message: 'the answer broke off' } };
    return;
  }
  yield* pieces(think.end());
  yield* closeTool();
  // Kiro may say only how full the context is, not how many tokens.
  if (!usage.input && pct > 0 && opts.contextWindow > 0) usage.input = Math.floor((pct / 100) * opts.contextWindow);
  if (!usage.output) usage.output = Math.floor((said + 3) / 4);
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  const out: UpstreamUsage = { prompt_tokens: prompt, completion_tokens: usage.output, total_tokens: prompt + usage.output };
  if (usage.cacheRead || usage.cacheWrite) {
    out.prompt_tokens_details = { cached_tokens: usage.cacheRead, ...(usage.cacheWrite ? { cache_write_tokens: usage.cacheWrite } : {}) };
  }
  yield { stop: tools > 0 ? 'tool_calls' : 'stop', usage: out };
}
