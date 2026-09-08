// Pure Server-Sent-Events codec for the translation proxy's streaming path.
//
// Both OpenAI Chat Completions and Anthropic Messages stream as `text/event-stream`.
// This module is the format-agnostic transport layer: turn an incoming byte/text
// stream into discrete SSE events (`SseDecoder`) and build outgoing SSE frames
// (`serializeSse`). The direction-specific state machines that decide WHICH events to
// emit live in the two translator modules; they consume `SseEvent`s from here and
// produce frames through here. No Node/Electron, no I/O — unit-testable with plain
// string fixtures.

/** One decoded SSE event. `event` is the optional `event:` name; `data` is the joined `data:` payload. */
export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Incremental SSE parser. Feed it text chunks (already UTF-8 decoded) as they arrive;
 * it returns whichever complete events the buffer now contains. Events are terminated
 * by a blank line, per the SSE spec. Comment lines (`:`), `id:` and `retry:` are ignored.
 */
export class SseDecoder {
  private buffer = '';

  /** Push a chunk of the stream; returns any events that completed within it. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    // Normalize CRLF so the blank-line split is simple.
    let sep = this.buffer.indexOf('\n\n');
    while (sep !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const parsed = parseEventBlock(raw);
      if (parsed) events.push(parsed);
      sep = this.buffer.indexOf('\n\n');
    }
    return events;
  }

  /** Flush any trailing event not terminated by a blank line (best-effort at stream end). */
  flush(): SseEvent[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest === '') return [];
    const parsed = parseEventBlock(rest);
    return parsed ? [parsed] : [];
  }
}

function parseEventBlock(block: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // Per spec a single leading space after the colon is stripped.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    // id/retry and unknown fields are ignored.
  }
  if (dataLines.length === 0 && event === undefined) return null;
  return { event, data: dataLines.join('\n') };
}

/** Build one SSE frame. Anthropic frames carry an `event:` name; OpenAI frames omit it. */
export function serializeSse(event: SseEvent): string {
  const lines: string[] = [];
  if (event.event !== undefined) lines.push(`event: ${event.event}`);
  // A data payload may contain newlines; emit one `data:` line per segment.
  for (const segment of event.data.split('\n')) lines.push(`data: ${segment}`);
  return `${lines.join('\n')}\n\n`;
}

/** Convenience: an OpenAI-style `data: <json>` frame (no event name). */
export function openAiFrame(data: string): string {
  return serializeSse({ data });
}

/** Convenience: a named `event:`+`data:` frame (Anthropic and OpenAI Responses share this shape). */
export function namedEventFrame(event: string, dataObject: unknown): string {
  return serializeSse({ event, data: JSON.stringify(dataObject) });
}

/** Convenience: an Anthropic-style named event frame. */
export function anthropicFrame(event: string, dataObject: unknown): string {
  return namedEventFrame(event, dataObject);
}
