import { describe, expect, it } from 'vitest';
import { decodeIpcError, encodeIpcError, isIpcErrorCode } from '../ipc-errors';

describe('ipc-errors — upstream codes round-trip', () => {
  // These generic upstream codes back the model-catalog fetch. They must survive
  // the `[CODE] message` wire form so the renderer can map them to friendly copy.
  for (const code of ['UNAUTHORIZED', 'UPSTREAM_ERROR'] as const) {
    it(`recognizes and round-trips ${code}`, () => {
      expect(isIpcErrorCode(code)).toBe(true);
      const decoded = decodeIpcError(encodeIpcError(code, 'boom'));
      expect(decoded.code).toBe(code);
      expect(decoded.message).toBe('boom');
    });
  }

  it('still falls back to INTERNAL for an unknown code', () => {
    expect(decodeIpcError('[NONSENSE] x').code).toBe('INTERNAL');
  });
});
