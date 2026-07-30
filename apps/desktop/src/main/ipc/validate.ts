// Runtime IPC payload validation — shared by every main-side handler.
//
// TypeScript types are NOT runtime validation. A handler validates structure,
// length, enum, range, and ownership BEFORE any side effect. See the security
// rule §5 and docs/dev-rules/engineering-conventions.md §2.

import type { IpcErrorCode } from '../../shared/ipc-errors';
import { encodeIpcError } from '../../shared/ipc-errors';

/** Throw an Error carrying an IPC error code. The wire message is `[CODE] msg`. */
export function throwIpcError(code: IpcErrorCode, message: string): never {
  const err = new Error(encodeIpcError(code, message));
  (err as { code?: IpcErrorCode }).code = code;
  throw err;
}

export function requireObject(value: unknown, name = 'payload'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throwIpcError('INVALID_PARAMS', `${name} is required`);
  }
  return value;
}

export function requireNonNegativeInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throwIpcError('INVALID_PARAMS', `${name} must be a non-negative integer`);
  }
  return value;
}

export function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throwIpcError(
      'INVALID_PARAMS',
      `invalid ${name}: ${String(value)} (expected ${allowed.join(' | ')})`,
    );
  }
  return value as T;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
