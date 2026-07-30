import { describe, expect, it } from 'vitest';
import { createInMemoryRegistry, type IpcHandler, type IpcInvokeMeta } from '../registry';
import { requireObject, requireString, throwIpcError } from '../validate';
import { decodeIpcError, isIpcError, type IpcErrorCode } from '../../../shared/ipc-errors';
import type { PingRequest, PingResult } from '../../../shared/ipc-channels';

// A representative handler: authorize the sender FIRST, then validate the payload
// at runtime, then do the work. Mirrors the vertical-slice shape.
const pingHandler: IpcHandler<unknown, PingResult> = (payload, meta) => {
  meta.assertTrustedSender();
  const obj = requireObject(payload);
  const message = requireString(obj.message, 'message');
  const req: PingRequest = { message };
  return { reply: `pong: ${req.message}`, at: 0 };
};

const trustedMeta: IpcInvokeMeta = { assertTrustedSender: () => {} };
const untrustedMeta: IpcInvokeMeta = {
  assertTrustedSender: () => throwIpcError('PERMISSION_DENIED', 'nope'),
};

/** Invoke and return the resulting IPC error code, or fail if it didn't throw one. */
async function invokeExpectingError(
  fn: () => Promise<unknown>,
): Promise<IpcErrorCode> {
  try {
    await fn();
  } catch (err) {
    if (isIpcError(err)) return err.code;
    // Fall back to the wire encoding for adapters that rethrow a plain Error.
    if (err instanceof Error) return decodeIpcError(err.message).code;
    throw err;
  }
  throw new Error('expected the invocation to throw');
}

describe('IpcHandlerRegistry (in-memory)', () => {
  it('runs the happy path for a trusted sender with a valid payload', async () => {
    const reg = createInMemoryRegistry();
    reg.register('app:ping', pingHandler as IpcHandler);
    const result = (await reg.invoke('app:ping', { message: 'hi' }, trustedMeta)) as PingResult;
    expect(result.reply).toBe('pong: hi');
  });

  it('rejects an untrusted sender with PERMISSION_DENIED', async () => {
    const reg = createInMemoryRegistry();
    reg.register('app:ping', pingHandler as IpcHandler);
    const code = await invokeExpectingError(() =>
      reg.invoke('app:ping', { message: 'hi' }, untrustedMeta),
    );
    expect(code).toBe('PERMISSION_DENIED');
  });

  it('rejects a bad payload with INVALID_PARAMS (trusted sender)', async () => {
    const reg = createInMemoryRegistry();
    reg.register('app:ping', pingHandler as IpcHandler);

    expect(
      await invokeExpectingError(() => reg.invoke('app:ping', { message: '' }, trustedMeta)),
    ).toBe('INVALID_PARAMS');

    expect(
      await invokeExpectingError(() => reg.invoke('app:ping', 'not-an-object', trustedMeta)),
    ).toBe('INVALID_PARAMS');
  });

  it('the coded error round-trips through the wire encoding', async () => {
    const reg = createInMemoryRegistry();
    reg.register('app:ping', pingHandler as IpcHandler);
    const code = await invokeExpectingError(() => reg.invoke('app:ping', {}, trustedMeta));
    expect(code).toBe('INVALID_PARAMS');
  });

  it('refuses to register the same channel twice', () => {
    const reg = createInMemoryRegistry();
    reg.register('app:ping', pingHandler as IpcHandler);
    expect(() => reg.register('app:ping', pingHandler as IpcHandler)).toThrow(/duplicate/);
  });
});
