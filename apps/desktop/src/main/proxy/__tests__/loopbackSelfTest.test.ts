import net from 'node:net';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { detectLoopbackBlock, runLoopbackSelfTest } from '../loopbackSelfTest';

/** A client socket double that never connects, optionally erroring with `code`. */
function deadSocket(code?: string): () => net.Socket {
  return () => {
    const s = new EventEmitter() as unknown as net.Socket;
    (s as unknown as { destroy: () => void }).destroy = () => {};
    if (code) setTimeout(() => s.emit('error', Object.assign(new Error(code), { code })), 5);
    return s;
  };
}

describe('loopback self-test', () => {
  it('reports ok on a normal machine', async () => {
    expect((await runLoopbackSelfTest()).outcome).toBe('ok');
  });

  it('reports blocked when the connect is dropped (ETIMEDOUT)', async () => {
    expect(await runLoopbackSelfTest({ connect: deadSocket('ETIMEDOUT') })).toMatchObject({
      outcome: 'blocked',
      code: 'ETIMEDOUT',
    });
  });

  it('reports blocked when nothing happens before the timer', async () => {
    expect(await runLoopbackSelfTest({ connect: deadSocket(), timeoutMs: 30 })).toMatchObject({
      outcome: 'blocked',
      code: 'TIMEOUT',
    });
  });

  it('treats a refusal / reset as inconclusive (not a firewall drop)', async () => {
    expect((await runLoopbackSelfTest({ connect: deadSocket('ECONNREFUSED') })).outcome).toBe('inconclusive');
  });

  it('needs every attempt dropped before reporting blocked', async () => {
    let n = 0;
    const flaky = (port: number, host: string): net.Socket =>
      n++ === 0 ? deadSocket('ETIMEDOUT')() : net.connect({ port, host });
    expect((await detectLoopbackBlock({ connect: flaky, retryDelayMs: 1 })).outcome).toBe('ok');
    expect((await detectLoopbackBlock({ connect: deadSocket('ETIMEDOUT'), retryDelayMs: 1 })).outcome).toBe('blocked');
  });
});
