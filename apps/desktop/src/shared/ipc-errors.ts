// IPC error protocol — shared by main, preload, and renderer.
//
// Codes are GENERIC and reusable. A product adds feature-specific categories to
// this union with tests; it does not smuggle them into free-text messages. See
// docs/dev-rules/engineering-conventions.md §2.

export type IpcErrorCode =
  | 'INVALID_PARAMS'
  | 'NOT_FOUND'
  | 'INTERNAL'
  | 'ALREADY_EXISTS'
  | 'PRECONDITION_FAILED'
  | 'PERMISSION_DENIED'
  | 'UNSUPPORTED_CAPABILITY';

/** The serializable error shape that crosses the IPC boundary to the renderer. */
export interface IpcError {
  code: IpcErrorCode;
  message: string;
}

const IPC_ERROR_CODES: ReadonlySet<IpcErrorCode> = new Set<IpcErrorCode>([
  'INVALID_PARAMS',
  'NOT_FOUND',
  'INTERNAL',
  'ALREADY_EXISTS',
  'PRECONDITION_FAILED',
  'PERMISSION_DENIED',
  'UNSUPPORTED_CAPABILITY',
]);

export function isIpcErrorCode(code: unknown): code is IpcErrorCode {
  return typeof code === 'string' && IPC_ERROR_CODES.has(code as IpcErrorCode);
}

/** An Error carrying a known IPC error code (as produced by `throwIpcError`). */
export function isIpcError(err: unknown): err is Error & { code: IpcErrorCode } {
  return err instanceof Error && isIpcErrorCode((err as { code?: unknown }).code);
}

// Errors are encoded on the wire as `[CODE] message` so the renderer can recover
// the code even if the structured-clone of a custom Error property is dropped.
const WIRE_PREFIX = /^\[([A-Z_]+)\]\s?(.*)$/s;

/** Encode a code + message into the wire form. */
export function encodeIpcError(code: IpcErrorCode, message: string): string {
  return `[${code}] ${message}`;
}

/** Recover an IpcError from a wire message, defaulting to INTERNAL. */
export function decodeIpcError(message: string): IpcError {
  const match = WIRE_PREFIX.exec(message);
  if (match && isIpcErrorCode(match[1])) {
    return { code: match[1], message: match[2] ?? '' };
  }
  return { code: 'INTERNAL', message };
}
