import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  connectFrame,
  connectFrames,
  field,
  fields,
  pb,
  pbAny,
  pbNum,
  pbStr,
  pbValue,
} from '../cursor/protobuf';

async function* chunks(...bs: Buffer[]): AsyncGenerator<Buffer> {
  for (const b of bs) yield b;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('cursor protobuf', () => {
  it('round-trips varints, strings and nested messages', () => {
    const msg = pb().varint(1, 300).str(2, 'héllo').bytes(3, pb().varint(1, 2 ** 40)).done();
    const fs = fields(msg);
    expect(pbNum(fs, 1)).toBe(300);
    expect(pbStr(fs, 2)).toBe('héllo');
    expect(pbNum(fields(field(fs, 3)!.data), 1)).toBe(2 ** 40);
  });

  it('drops a truncated tail instead of throwing', () => {
    const msg = pb().str(1, 'abc').str(2, 'defgh').done();
    const fs = fields(msg.subarray(0, msg.length - 2));
    expect(fs.map((f) => f.num)).toEqual([1]);
  });

  it('encodes and decodes google.protobuf.Value', () => {
    const v = { a: 1.5, b: ['x', true, null], c: { d: 'e' } };
    expect(pbAny(pbValue(v).done())).toEqual(v);
  });
});

describe('connect frames', () => {
  it('reads frames split across chunks, gunzips flag 1 and marks the end', async () => {
    const a = connectFrame(Buffer.from('one'));
    const b = connectFrame(gzipSync(Buffer.from('two')), 1);
    const end = connectFrame(Buffer.from('{}'), 2);
    const all = Buffer.concat([a, b, end]);
    const frames = await collect(connectFrames(chunks(all.subarray(0, 3), all.subarray(3, 11), all.subarray(11))));
    expect(frames.map((f) => [f.end, f.data.toString()])).toEqual([
      [false, 'one'],
      [false, 'two'],
      [true, '{}'],
    ]);
  });

  it('throws on a truncated stream', async () => {
    const a = connectFrame(Buffer.from('abcdef'));
    await expect(collect(connectFrames(chunks(a.subarray(0, 7))))).rejects.toThrow('unexpected EOF');
  });
});
