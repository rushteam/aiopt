// Strict JSONL framing for pi's RPC mode.
//
// pi frames records with LF only, tolerating a trailing CR (docs/rpc.md "Framing"). Node's
// `readline` is NOT a match: it also splits on U+2028 / U+2029, which are legal inside a JSON
// string, so a reply containing one would be cut in half and both halves dropped. This decoder
// buffers raw chunks, splits on '\n' alone, and hands each complete line to `onRecord`.
//
// Pure — no I/O. A line that is not a JSON object is skipped (reported via `onInvalid`), never
// thrown, so one bad record cannot wedge the stream.

/** Hard cap on one buffered line; a runaway record is dropped rather than growing memory. */
export const MAX_JSONL_LINE = 8 * 1024 * 1024;

export interface JsonlDecoder {
  push(chunk: string): void;
  /** Flush a final unterminated line (at stream end). */
  end(): void;
}

export function createJsonlDecoder(
  onRecord: (record: Record<string, unknown>) => void,
  onInvalid: (reason: 'parse' | 'not_object' | 'too_long') => void = () => {},
): JsonlDecoder {
  let buffer = '';
  let discarding = false;

  function handleLine(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      onInvalid('parse');
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      onInvalid('not_object');
      return;
    }
    onRecord(value as Record<string, unknown>);
  }

  return {
    push(chunk) {
      let start = 0;
      for (let i = chunk.indexOf('\n'); i !== -1; i = chunk.indexOf('\n', start)) {
        const piece = chunk.slice(start, i);
        if (discarding) discarding = false;
        else handleLine(buffer + piece);
        buffer = '';
        start = i + 1;
      }
      if (discarding) return;
      buffer += chunk.slice(start);
      if (buffer.length > MAX_JSONL_LINE) {
        buffer = '';
        discarding = true;
        onInvalid('too_long');
      }
    },
    end() {
      if (!discarding && buffer !== '') handleLine(buffer);
      buffer = '';
      discarding = false;
    },
  };
}

/** Serialize one record as a JSONL line. JSON.stringify escapes every raw newline. */
export function encodeJsonl(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}
