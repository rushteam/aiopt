import { describe, expect, it } from 'vitest';
import { decode, failure, isMaxModeRequired, isRegional, type CursorEvent } from '../cursor/decode';
import { field, fields, pb, pbNum, pbValue, type ConnectFrame } from '../cursor/protobuf';
import type { CursorTool } from '../cursor/conversation';

async function* frames(...fs: ConnectFrame[]): AsyncGenerator<ConnectFrame> {
  for (const f of fs) yield f;
}
const msg = (b: Buffer): ConnectFrame => ({ end: false, data: b });
const update = (num: number, inner: ReturnType<typeof pb>): Buffer => pb().bytes(1, pb().bytes(num, inner)).done();

async function run(fs: ConnectFrame[], opts: { tools?: CursorTool[]; blobs?: Map<string, Buffer> } = {}) {
  const sent: Buffer[] = [];
  const events: CursorEvent[] = [];
  for await (const e of decode(frames(...fs), {
    send: (m) => sent.push(m),
    blobs: opts.blobs ?? new Map(),
    tools: opts.tools ?? [],
    estimate: 10,
  })) {
    events.push(e);
  }
  return { sent, events };
}

describe('cursor decode', () => {
  it('streams text and thinking, then stops with Cursor usage', async () => {
    const { events } = await run([
      msg(update(4, pb().str(1, 'hmm'))),
      msg(update(1, pb().str(1, 'Hello'))),
      msg(update(14, pb().varint(1, 100).varint(2, 5).varint(3, 40))),
    ]);
    expect(events).toEqual([
      { reasoning: 'hmm' },
      { text: 'Hello' },
      {
        stop: 'stop',
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 } },
      },
    ]);
  });

  it('returns a call of the caller tools and stops once the step is done', async () => {
    const args = pb().str(1, 'aiopt-read').bytes(2, pb().str(1, 'path').bytes(2, pbValue('a'))).str(3, 'call_x\nfc_y').str(5, 'read');
    const { events, sent } = await run([
      msg(update(27, pb().varint(1, 1))),
      msg(pb().bytes(2, pb().varint(1, 7).bytes(11, args)).done()),
    ]);
    expect(events[0]).toEqual({ tool: { index: 0, id: 'call_x__fc_y', name: 'read', args: '{"path":"a"}' } });
    expect(events[1]).toMatchObject({ stop: 'tool_calls' });
    expect(sent).toHaveLength(0);
  });

  it("refuses Cursor's own tools and serves blobs it asks for", async () => {
    const blob = Buffer.from('blob');
    const id = Buffer.alloc(32, 1);
    const { sent, events } = await run(
      [
        msg(pb().bytes(2, pb().varint(1, 3).bytes(14, pb().str(1, 'ls'))).done()), // a shell call
        msg(pb().bytes(4, pb().varint(1, 9).bytes(2, pb().bytes(1, id))).done()),
        msg(update(1, pb().str(1, 'ok'))),
        { end: true, data: Buffer.from('{}') },
      ],
      { blobs: new Map([[id.toString('hex'), blob]]) },
    );
    // refusal (exec client message, field 5) + close, then the kv answer (field 3)
    expect(sent.map((s) => fields(s)[0]!.num)).toEqual([5, 5, 3]);
    const kv = fields(field(fields(sent[2]!), 3)!.data);
    expect(pbNum(kv, 1)).toBe(9);
    expect(field(fields(field(kv, 2)!.data), 1)!.data.toString()).toBe('blob');
    expect(events.at(-1)).toMatchObject({ stop: 'stop' });
  });

  it('reports an end-frame error and an empty reply', async () => {
    const err = await run([
      { end: true, data: Buffer.from(JSON.stringify({ error: { code: 'resource_exhausted', message: 'usage limit' } })) },
    ]);
    expect(err.events).toEqual([{ error: { status: 429, message: 'usage limit' } }]);
    const empty = await run([{ end: true, data: Buffer.from('{}') }]);
    expect(empty.events[0]).toMatchObject({ error: { status: 502 } });
  });
});

describe('cursor failure', () => {
  it('maps Connect errors and recognizes retryable ones', () => {
    expect(failure(401, '{"code":"unauthenticated","message":"bad"}').status).toBe(401);
    const debug = failure(
      400,
      JSON.stringify({ code: 'invalid_argument', details: [{ debug: { details: { title: 'Max mode required', detail: 'x' } } }] }),
    );
    expect(isMaxModeRequired(debug)).toBe(true);
    expect(isRegional(failure(403, '{"code":"permission_denied","message":"not served in your region"}'))).toBe(true);
    expect(failure(500, 'oops')).toEqual({ status: 500, message: 'oops' });
  });
});
