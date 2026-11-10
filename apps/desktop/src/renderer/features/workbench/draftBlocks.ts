// Long text in a chat draft, held out of the field the way pi's editor does it. A large paste
// (or a quoted line range from the file preview) goes into the field as a short marker such as
// `[粘贴 #1 · 120 行]`. Its text is kept here and put back in place of the marker when the
// message is sent. The field stays readable, and the agent gets the full text.
//
// Markers are matched as exact strings, so a marker the user has edited is no longer replaced
// and goes out as typed (as in pi). Nothing here is persisted: a draft's blocks live only as
// long as its composer does.

/** A paste longer than this many lines or characters becomes a marker. These match pi's editor. */
export const LARGE_PASTE_LINES = 10;
export const LARGE_PASTE_CHARS = 1000;

export function isLargePaste(text: string): boolean {
  return text.length > LARGE_PASTE_CHARS || text.split('\n', LARGE_PASTE_LINES + 2).length > LARGE_PASTE_LINES;
}

/** Pasted text with line endings normalised (the field and the agent both expect `\n`). */
export function normalizePaste(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export interface DraftBlock {
  marker: string;
  text: string;
  /** Expanded on lines of its own (a fenced quote must start and end a line). */
  ownLines: boolean;
}

export class DraftBlocks {
  private blocks: DraftBlock[] = [];
  private pastes = 0;

  /** The next paste number for a marker label (#1, #2, … within this draft). */
  nextPasteId(): number {
    this.pastes += 1;
    return this.pastes;
  }

  /**
   * Store `text` under `[label]` and return that marker. A block that already has the same
   * marker is replaced, so a marker always stands for its newest text.
   */
  add(text: string, label: string, ownLines = false): string {
    const marker = `[${label}]`;
    this.blocks = this.blocks.filter((b) => b.marker !== marker);
    this.blocks.push({ marker, text, ownLines });
    return marker;
  }

  /** The marker of a block holding exactly `text` that is still in `draft`, if any. */
  markerFor(text: string, draft: string): string | null {
    return this.blocks.find((b) => b.text === text && draft.includes(b.marker))?.marker ?? null;
  }

  /** `draft` with every marker replaced by its text. This is done in one pass, so a block's text is never expanded again. */
  expand(draft: string): string {
    const live = this.blocks.filter((b) => draft.includes(b.marker));
    if (live.length === 0) return draft;
    const byMarker = new Map(live.map((b) => [b.marker, b]));
    const pattern = new RegExp(live.map((b) => escapeRegExp(b.marker)).join('|'), 'g');
    return draft.replace(pattern, (m: string, at: number) => {
      const block = byMarker.get(m);
      if (!block) return m;
      if (!block.ownLines) return block.text;
      const before = at > 0 && draft[at - 1] !== '\n' ? '\n' : '';
      const end = at + m.length;
      const after = end < draft.length && draft[end] !== '\n' ? '\n' : '';
      return `${before}${block.text}${after}`;
    });
  }

  /**
   * The span of a marker that ends at `caret` (for Backspace) or starts there (for Delete),
   * so a single key press removes the whole marker.
   */
  markerAt(draft: string, caret: number, side: 'before' | 'after'): { start: number; end: number } | null {
    for (const { marker } of this.blocks) {
      const start = side === 'before' ? caret - marker.length : caret;
      if (start >= 0 && draft.startsWith(marker, start)) return { start, end: start + marker.length };
    }
    return null;
  }

  /** Where each stored marker sits in `draft`, in text order. */
  spans(draft: string): MarkerSpan[] {
    const out: MarkerSpan[] = [];
    for (const { marker } of this.blocks) {
      for (let at = draft.indexOf(marker); at >= 0; at = draft.indexOf(marker, at + marker.length)) {
        out.push({ start: at, end: at + marker.length });
      }
    }
    return out.sort((x, y) => x.start - y.start);
  }

  /** How many stored blocks still have their marker in `draft`. */
  liveCount(draft: string): number {
    return this.blocks.filter((b) => draft.includes(b.marker)).length;
  }

  clear(): void {
    this.blocks = [];
    this.pastes = 0;
  }
}

export interface MarkerSpan {
  start: number;
  end: number;
}

/**
 * Keep markers whole across an edit from `prev` to `next` (`spans` are the markers in `prev`).
 * An edit that removes or replaces part of a marker removes all of it; text typed inside a
 * marker lands after it. Returns the repaired text and caret, or null when no marker was touched.
 */
export function repairMarkers(
  prev: string,
  next: string,
  spans: readonly MarkerSpan[],
): { text: string; caret: number } | null {
  if (spans.length === 0 || prev === next) return null;
  // The edited region: prev[start, prevEnd) became next[start, nextEnd).
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev[start] === next[start]) start += 1;
  let tail = 0;
  while (tail < max - start && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;
  let from = start;
  let to = prev.length - tail;
  const inserted = next.slice(start, next.length - tail);
  if (from === to) {
    // A pure insertion inside a marker goes after it.
    const inside = spans.find((m) => m.start < from && from < m.end);
    if (!inside) return null;
    const text = prev.slice(0, inside.end) + inserted + prev.slice(inside.end);
    return { text, caret: inside.end + inserted.length };
  }
  let touched = false;
  for (const m of spans) {
    if (m.end <= from || m.start >= to) continue;
    if (m.start < from || m.end > to) touched = true;
    from = Math.min(from, m.start);
    to = Math.max(to, m.end);
  }
  if (!touched) return null;
  return { text: prev.slice(0, from) + inserted + prev.slice(to), caret: from + inserted.length };
}

/**
 * A selection moved off marker interiors: a caret inside a marker goes to its nearer edge, a
 * range that cuts into a marker grows to cover it. Null when nothing needs to move.
 */
export function snapSelection(
  start: number,
  end: number,
  spans: readonly MarkerSpan[],
): { start: number; end: number } | null {
  let s = start;
  let e = end;
  for (const m of spans) {
    if (s === e) {
      if (m.start < s && s < m.end) {
        const edge = s - m.start <= m.end - s ? m.start : m.end;
        return { start: edge, end: edge };
      }
      continue;
    }
    if (m.start < s && s < m.end) s = m.start;
    if (m.start < e && e < m.end) e = m.end;
  }
  return s === start && e === end ? null : { start: s, end: e };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Insert `piece` at `start`..`end` of `draft`, with a space on either side where it would touch a word. */
export function insertAt(draft: string, start: number, end: number, piece: string): { text: string; caret: number } {
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : '';
  const trail = after !== '' && !/^\s/.test(after) ? ' ' : '';
  const text = `${before}${lead}${piece}${trail}${after}`;
  return { text, caret: before.length + lead.length + piece.length + trail.length };
}

// ─── Showing a sent message ──────────────────────────────────────────────────

export type MessageSegment = { kind: 'text'; text: string } | { kind: 'code'; lang: string; text: string };

/**
 * A user message split into plain text and fenced code blocks, so a bubble can show quoted
 * code as code. A fence that is never closed runs to the end of the message.
 */
export function splitFences(text: string): MessageSegment[] {
  const out: MessageSegment[] = [];
  const lines = text.split('\n');
  let plain: string[] = [];
  const flush = (): void => {
    const joined = plain.join('\n');
    if (joined.trim() !== '') out.push({ kind: 'text', text: joined.replace(/^\n+|\n+$/g, '') });
    plain = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/.exec(lines[i]!);
    if (!open) {
      plain.push(lines[i]!);
      continue;
    }
    flush();
    const fence = open[1]!;
    const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !close.test(lines[j]!); j += 1) body.push(lines[j]!);
    out.push({ kind: 'code', lang: open[2] ?? '', text: body.join('\n') });
    i = j;
  }
  flush();
  return out;
}

/** How a long block is cut while collapsed: the head and how many lines it has in all. */
export function collapsedHead(
  text: string,
  maxLines: number,
  maxChars: number,
): { head: string; lines: number } | null {
  const lines = text.split('\n');
  if (lines.length <= maxLines + 2 && text.length <= maxChars) return null;
  let head = lines.slice(0, maxLines).join('\n');
  if (head.length > maxChars) head = head.slice(0, maxChars).replace(/\s+\S*$/, '');
  return { head, lines: lines.length };
}
