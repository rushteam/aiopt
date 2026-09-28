import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createPiRpcClient, PiRpcError, type PiChild } from '../piRpc';

class FakeChild extends EventEmitter {
  written: Record<string, unknown>[] = [];
  killed = false;
  stdoutEmitter = new EventEmitter();
  stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) this.written.push(JSON.parse(line));
      return true;
    },
    end: () => {},
  };
  stdout = {
    setEncoding: () => {},
    on: (ev: 'data', cb: (chunk: string) => void) => this.stdoutEmitter.on(ev, cb),
  };
  kill() {
    this.killed = true;
  }
  emitLine(record: unknown) {
    this.stdoutEmitter.emit('data', `${JSON.stringify(record)}\n`);
  }
}

function setup() {
  const child = new FakeChild();
  const onEvent = vi.fn();
  const onExit = vi.fn();
  const rpc = createPiRpcClient(child as unknown as PiChild, { onEvent, onExit, timeoutMs: 1000 });
  return { child, onEvent, onExit, rpc };
}

describe('pi rpc client', () => {
  it('correlates responses to commands by id', async () => {
    const { child, rpc } = setup();
    const done = rpc.prompt('hello', false);
    expect(child.written[0]).toEqual({ type: 'prompt', message: 'hello', id: 'r1' });
    child.emitLine({ type: 'response', id: 'r1', command: 'prompt', success: true });
    await expect(done).resolves.toBeUndefined();
  });

  it('sends an extension command as a plain prompt, never queued', () => {
    const { child, rpc } = setup();
    void rpc.command('/aiopt-task-update abc');
    expect(child.written[0]).toEqual({ type: 'prompt', message: '/aiopt-task-update abc', id: 'r1' });
  });

  it('reads session state and messages, tolerating junk data', async () => {
    const { child, rpc } = setup();
    const state = rpc.getState();
    child.emitLine({
      type: 'response',
      id: 'r1',
      success: true,
      data: { sessionFile: '/s/a.jsonl', sessionId: 'x', messageCount: 3 },
    });
    await expect(state).resolves.toEqual({ sessionFile: '/s/a.jsonl', sessionId: 'x', messageCount: 3 });

    const junk = rpc.getState();
    child.emitLine({ type: 'response', id: 'r2', success: true, data: { sessionFile: 7, messageCount: 'many' } });
    await expect(junk).resolves.toEqual({ sessionFile: null, sessionId: null, messageCount: 0 });

    const messages = rpc.getMessages();
    child.emitLine({ type: 'response', id: 'r3', success: true, data: { messages: [{ role: 'user' }] } });
    await expect(messages).resolves.toEqual([{ role: 'user' }]);

    const none = rpc.getMessages();
    child.emitLine({ type: 'response', id: 'r4', success: true });
    await expect(none).resolves.toEqual([]);
  });

  it('switches to a session file by path', () => {
    const { child, rpc } = setup();
    void rpc.switchSession('/s/b.jsonl');
    expect(child.written[0]).toEqual({ type: 'switch_session', sessionPath: '/s/b.jsonl', id: 'r1' });
  });

  it('queues a prompt as a follow-up while streaming', () => {
    const { child, rpc } = setup();
    void rpc.prompt('more', true);
    expect(child.written[0]).toMatchObject({ type: 'prompt', message: 'more', streamingBehavior: 'followUp' });
  });

  it('rejects a command pi refused', async () => {
    const { child, rpc } = setup();
    const done = rpc.abort();
    child.emitLine({ type: 'response', id: 'r1', success: false, error: 'nope' });
    await expect(done).rejects.toEqual(new PiRpcError('nope'));
  });

  it('forwards events and hides responses and UI requests from them', () => {
    const { child, onEvent } = setup();
    child.emitLine({ type: 'agent_start' });
    child.emitLine({ type: 'response', id: 'zzz', success: true });
    child.emitLine({ type: 'extension_ui_request', id: 'u1', method: 'notify', message: 'x' });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: 'agent_start' });
  });

  it('cancels blocking extension dialogs but not fire-and-forget ones', () => {
    const { child } = setup();
    child.emitLine({ type: 'extension_ui_request', id: 'u1', method: 'confirm', title: 'ok?' });
    child.emitLine({ type: 'extension_ui_request', id: 'u2', method: 'setStatus' });
    expect(child.written).toEqual([{ type: 'extension_ui_response', id: 'u1', cancelled: true }]);
  });

  it('rejects pending commands and reports once when the process exits', async () => {
    const { child, onExit, rpc } = setup();
    const done = rpc.newSession();
    child.emit('exit', 1, null);
    child.emit('exit', 1, null);
    await expect(done).rejects.toBeInstanceOf(PiRpcError);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(1);
    expect(rpc.exited).toBe(true);
    await expect(rpc.prompt('late', false)).rejects.toBeInstanceOf(PiRpcError);
  });

  it('times out a command pi never answers', async () => {
    vi.useFakeTimers();
    try {
      const { rpc } = setup();
      const done = rpc.abort();
      vi.advanceTimersByTime(1001);
      await expect(done).rejects.toEqual(new PiRpcError('pi did not respond'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose kills the child and settles', async () => {
    const { child, onExit, rpc } = setup();
    const done = rpc.abort();
    rpc.dispose();
    expect(child.killed).toBe(true);
    await expect(done).rejects.toBeInstanceOf(PiRpcError);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
