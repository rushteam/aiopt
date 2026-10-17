// Hand-rolled protobuf + Connect framing for Cursor's agent API.
//
// Cursor's `agent.v1.AgentService/Run` speaks Connect over a bidirectional stream of
// protobuf messages. We do not ship its .proto files; the handful of messages we need are
// written and read by field number.
//
// Pure module: no I/O. Unit-tested in upstreams/__tests__/cursorProtobuf.test.ts.

import { gunzipSync } from 'node:zlib';

const EMPTY = Buffer.alloc(0);

/** A protobuf message builder (append-only). */
export class PB {
  private parts: Buffer[] = [];

  private push(b: Buffer | Uint8Array): this {
    this.parts.push(Buffer.isBuffer(b) ? b : Buffer.from(b));
    return this;
  }

  private uv(v: number): this {
    const out: number[] = [];
    let n = v;
    while (n >= 0x80) {
      out.push((n % 128) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(n);
    return this.push(Uint8Array.from(out));
  }

  private tag(num: number, wire: number): this {
    return this.uv(num * 8 + wire);
  }

  varint(num: number, v: number): this {
    return this.tag(num, 0).uv(v);
  }

  bytes(num: number, v: PB | Buffer | Uint8Array | null | undefined): this {
    const b = v instanceof PB ? v.done() : v ? Buffer.from(v) : EMPTY;
    return this.tag(num, 2).uv(b.length).push(b);
  }

  str(num: number, s: string): this {
    return this.bytes(num, Buffer.from(s, 'utf8'));
  }

  double(num: number, v: number): this {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v);
    return this.tag(num, 1).push(b);
  }

  done(): Buffer {
    return Buffer.concat(this.parts);
  }
}

export const pb = (): PB => new PB();

/** One decoded field: its number, wire type, varint/fixed value, and length-delimited bytes. */
export interface PbField {
  num: number;
  wire: number;
  n: number;
  data: Buffer;
}

/** Read a message's top-level fields; a malformed tail is dropped (never throws). */
export function fields(input: Buffer | Uint8Array | null | undefined): PbField[] {
  const b = input ? (Buffer.isBuffer(input) ? input : Buffer.from(input)) : EMPTY;
  const out: PbField[] = [];
  let i = 0;
  const uv = (): number => {
    let v = 0;
    let m = 1;
    while (i < b.length) {
      const c = b[i++]!;
      v += (c & 0x7f) * m;
      if (c < 0x80) return v;
      m *= 128;
    }
    return -1;
  };
  while (i < b.length) {
    const key = uv();
    if (key < 0) break;
    const f: PbField = { num: Math.floor(key / 8), wire: key % 8, n: 0, data: EMPTY };
    switch (f.wire) {
      case 0: {
        const v = uv();
        if (v < 0) return out;
        f.n = v;
        break;
      }
      case 1:
        if (i + 8 > b.length) return out;
        f.data = b.subarray(i, i + 8);
        f.n = Number(b.readBigUInt64LE(i));
        i += 8;
        break;
      case 2: {
        const l = uv();
        if (l < 0 || i + l > b.length) return out;
        f.data = b.subarray(i, i + l);
        i += l;
        break;
      }
      case 5:
        if (i + 4 > b.length) return out;
        f.n = b.readUInt32LE(i);
        i += 4;
        break;
      default:
        return out;
    }
    out.push(f);
  }
  return out;
}

export const field = (fs: PbField[], num: number): PbField | undefined => fs.find((f) => f.num === num);
export const pbStr = (fs: PbField[], num: number): string => field(fs, num)?.data.toString('utf8') ?? '';
export const pbNum = (fs: PbField[], num: number): number => field(fs, num)?.n ?? 0;

/** Encode a JSON value as a `google.protobuf.Value`. */
export function pbValue(v: unknown): PB {
  if (v === null || v === undefined) return pb().varint(1, 0);
  if (typeof v === 'number') return pb().double(2, v);
  if (typeof v === 'string') return pb().str(3, v);
  if (typeof v === 'boolean') return pb().varint(4, v ? 1 : 0);
  if (Array.isArray(v)) {
    const l = pb();
    for (const e of v) l.bytes(1, pbValue(e));
    return pb().bytes(6, l);
  }
  if (typeof v === 'object') {
    const st = pb();
    const obj = v as Record<string, unknown>;
    for (const k of Object.keys(obj).sort()) st.bytes(1, pb().str(1, k).bytes(2, pbValue(obj[k])));
    return pb().bytes(5, st);
  }
  return pb().varint(1, 0);
}

/** Decode a `google.protobuf.Value` back into a JSON value. */
export function pbAny(b: Buffer): unknown {
  for (const f of fields(b)) {
    switch (f.num) {
      case 1:
        return null;
      case 2:
        return f.data.length === 8 ? f.data.readDoubleLE(0) : 0;
      case 3:
        return f.data.toString('utf8');
      case 4:
        return f.n !== 0;
      case 5: {
        const m: Record<string, unknown> = {};
        for (const e of fields(f.data)) {
          if (e.num !== 1) continue;
          const kv = fields(e.data);
          const v = field(kv, 2);
          m[pbStr(kv, 1)] = v ? pbAny(v.data) : null;
        }
        return m;
      }
      case 6:
        return fields(f.data)
          .filter((e) => e.num === 1)
          .map((e) => pbAny(e.data));
    }
  }
  return null;
}

/** Wrap one message as a Connect stream frame (flag byte + big-endian u32 length). */
export function connectFrame(msg: Buffer, flags = 0): Buffer {
  const head = Buffer.alloc(5);
  head[0] = flags;
  head.writeUInt32BE(msg.length, 1);
  return Buffer.concat([head, msg]);
}

/** One Connect frame read off a stream: a message, or the stream's end (JSON). */
export interface ConnectFrame {
  end: boolean;
  data: Buffer;
}

const MAX_FRAME = 64 << 20;

/** Read Connect frames off a byte stream. Throws "unexpected EOF" on a truncated tail. */
export async function* connectFrames(body: AsyncIterable<Uint8Array>): AsyncGenerator<ConnectFrame> {
  let buf: Buffer = EMPTY;
  for await (const chunk of body) {
    buf = buf.length ? Buffer.concat([buf, Buffer.from(chunk)]) : Buffer.from(chunk);
    while (buf.length >= 5) {
      const n = buf.readUInt32BE(1);
      if (n > MAX_FRAME) throw new Error('a malformed stream');
      if (buf.length < 5 + n) break;
      const flags = buf[0]!;
      let data = buf.subarray(5, 5 + n);
      buf = buf.subarray(5 + n);
      if (flags & 1) data = gunzipSync(data);
      yield { end: (flags & 2) !== 0, data };
    }
  }
  if (buf.length) throw new Error('unexpected EOF');
}
