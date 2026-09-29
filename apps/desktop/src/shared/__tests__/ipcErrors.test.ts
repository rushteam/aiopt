import { describe, expect, it } from 'vitest';
import {
  decodeIpcError,
  encodeIpcError,
  ipcErrorFromUnknown,
  ipcWireMessageFromUnknown,
  isIpcErrorCode,
} from '../ipc-errors';
import { SKILL_IMPORT_FAIL } from '../skills';

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

  it('ipcErrorFromUnknown decodes Electron-style plain rejections', () => {
    const wire = encodeIpcError('INVALID_PARAMS', SKILL_IMPORT_FAIL.missingMarker);
    expect(ipcWireMessageFromUnknown({ message: wire })).toBe(wire);
    expect(ipcErrorFromUnknown({ message: wire })).toEqual({
      code: 'INVALID_PARAMS',
      message: SKILL_IMPORT_FAIL.missingMarker,
    });
  });
});
