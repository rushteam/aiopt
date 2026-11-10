// A small Markdown parser for the file preview's rendered view. It turns text into a plain data
// tree that `MarkdownView` maps to React elements — nothing here builds HTML, so raw HTML in a
// file stays visible text and no markup or script from the file can reach the DOM. It covers
// what READMEs and notes use (CommonMark blocks + GFM tables, task lists, strikethrough,
// autolinks), not every corner of the spec; whatever it does not recognise reads as text.

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'em' | 'strong' | 'del'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'image'; alt: string; src: string }
  | { type: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItem {
  /** A task-list item's box (`[ ]` / `[x]`); null for a plain item. */
  checked: boolean | null;
  children: Block[];
}

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; children: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: 'hr' };

/** Nesting depth past which quotes / lists stop recursing (their text is kept as paragraphs). */
const MAX_DEPTH = 12;
/**
 * How far an inline opener (`*`, `[`, `` ` ``) looks for its closer. Bounding it keeps a large
 * file with many unmatched markers linear instead of quadratic; real spans are far shorter.
 */
const INLINE_WINDOW = 1000;

/** File names the preview offers a rendered view for. */
export function isMarkdownPath(relPath: string): boolean {
  return /\.(md|markdown|mdown|mkd|mdx)$/i.test(relPath);
}

/** A link target the view may make clickable: absolute http(s) only (main opens it externally). */
export function isExternalHref(href: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(href);
}

// ─── Blocks ──────────────────────────────────────────────────────────────────

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return parseBlocks(lines.map(expandTabs), 0);
}

function expandTabs(line: string): string {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) out += ch === '\t' ? ' '.repeat(4 - (out.length % 4)) : ch;
  return out;
}

const isBlank = (line: string): boolean => line.trim() === '';
const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Does `line` start a block that ends a running paragraph? */
function interrupts(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    (LIST_ITEM.test(line) && !isBlank(line.replace(LIST_ITEM, ''))) ||
    (line.includes('|') && next !== undefined && TABLE_DELIM.test(next) && next.includes('-'))
  );
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const indent = indentOf(line);
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const l = lines[i]!;
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) {
          i += 1;
          break;
        }
        body.push(l.slice(Math.min(indent, indentOf(l))));
        i += 1;
      }
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const raw = (heading[2] ?? '').replace(/(^|[ \t]+)#+[ \t]*$/, '');
      const level = heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: 'heading', level, children: parseInline(raw) });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i]!)) {
        const l = lines[i]!;
        if (QUOTE.test(l)) body.push(l.replace(QUOTE, ''));
        else if (body.length > 0 && !interrupts(l, lines[i + 1]))
          body.push(l); // lazy continuation
        else break;
        i += 1;
      }
      blocks.push(
        depth < MAX_DEPTH
          ? { type: 'quote', children: parseBlocks(body, depth + 1) }
          : { type: 'paragraph', children: parseInline(body.join('\n')) },
      );
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const parsed = parseList(lines, i, depth);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && TABLE_DELIM.test(next) && next.includes('-')) {
      const head = splitRow(line);
      const align = splitRow(next).map(alignOf);
      if (head.length === align.length) {
        const rows: Inline[][][] = [];
        i += 2;
        while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes('|')) {
          const cells = splitRow(lines[i]!);
          rows.push(head.map((_, c) => parseInline(cells[c] ?? '')));
          i += 1;
        }
        blocks.push({ type: 'table', align, head: head.map((h) => parseInline(h)), rows });
        continue;
      }
    }

    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length && (isBlank(lines[i]!) || indentOf(lines[i]!) >= 4)) {
        body.push(lines[i]!.slice(4));
        i += 1;
      }
      while (body.length > 0 && isBlank(body[body.length - 1]!)) body.pop();
      blocks.push({ type: 'code', lang: '', text: body.join('\n') });
      continue;
    }

    // A paragraph, or a setext heading when an `===` / `---` line follows it.
    const body: string[] = [line.trim()];
    i += 1;
    let level: 1 | 2 | null = null;
    while (i < lines.length && !isBlank(lines[i]!)) {
      const l = lines[i]!;
      const setext = SETEXT.exec(l);
      if (setext) {
        level = setext[1]![0] === '=' ? 1 : 2;
        i += 1;
        break;
      }
      if (interrupts(l, lines[i + 1])) break;
      body.push(l.trim());
      i += 1;
    }
    const inline = parseInline(body.join('\n'));
    blocks.push(level ? { type: 'heading', level, children: inline } : { type: 'paragraph', children: inline });
  }
  return blocks;
}

function parseList(lines: string[], from: number, depth: number): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[from]!)!;
  const ordered = /\d/.test(first[2]!);
  const kind = ordered ? first[2]!.slice(-1) : first[2]!;
  const start = ordered ? Number.parseInt(first[2]!, 10) : 1;
  const items: ListItem[] = [];
  let i = from;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]!);
    if (!m || (ordered ? !/\d/.test(m[2]!) || m[2]!.slice(-1) !== kind : m[2] !== kind)) break;
    const contentIndent = m[0].length === lines[i]!.length ? m[1]!.length + m[2]!.length + 1 : m[0].length;
    const body: string[] = [lines[i]!.slice(m[0].length)];
    i += 1;
    while (i < lines.length) {
      const l = lines[i]!;
      if (isBlank(l)) {
        // A blank line stays in the item only when indented content follows it.
        let j = i;
        while (j < lines.length && isBlank(lines[j]!)) j += 1;
        if (j < lines.length && indentOf(lines[j]!) >= contentIndent) {
          for (; i < j; i += 1) body.push('');
          continue;
        }
        break;
      }
      if (indentOf(l) >= contentIndent) body.push(l.slice(contentIndent));
      else if (LIST_ITEM.test(l) || interrupts(l, lines[i + 1])) break;
      else body.push(l.trim()); // lazy continuation of the item's paragraph
      i += 1;
    }
    let checked: boolean | null = null;
    const task = /^\[([ xX])\][ \t]+/.exec(body[0]!);
    if (task) {
      checked = task[1] !== ' ';
      body[0] = body[0]!.slice(task[0].length);
    }
    items.push({
      checked,
      children:
        depth < MAX_DEPTH
          ? parseBlocks(body, depth + 1)
          : [{ type: 'paragraph', children: parseInline(body.join('\n')) }],
    });
    // A blank line between items ends the list only if no further item follows.
    let j = i;
    while (j < lines.length && isBlank(lines[j]!)) j += 1;
    if (j > i && j < lines.length && LIST_ITEM.test(lines[j]!)) i = j;
  }
  return { block: { type: 'list', ordered, start, items }, next: i };
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let ticks = 0;
  for (let k = 0; k < row.length; k += 1) {
    const ch = row[k]!;
    if (ch === '\\' && row[k + 1] === '|') {
      cell += '|';
      k += 1;
    } else if (ch === '`') {
      ticks ^= 1;
      cell += ch;
    } else if (ch === '|' && ticks === 0) {
      cells.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

// ─── Inline ──────────────────────────────────────────────────────────────────

const PUNCT = /[!-/:-@[-`{-~]/;
const AUTOLINK = /^<(https?:\/\/[^\s<>]+)>/i;
const BARE_URL = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_~]/i;

export function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) out.push({ type: 'text', text: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const rest = text.slice(i);

    if (ch === '\\' && i + 1 < text.length) {
      if (text[i + 1] === '\n') {
        flush();
        out.push({ type: 'br' });
        i += 2;
        continue;
      }
      if (PUNCT.test(text[i + 1]!)) {
        buf += text[i + 1];
        i += 2;
        continue;
      }
    }

    if (ch === '\n') {
      if (/ {2,}$/.test(buf)) {
        buf = buf.replace(/ +$/, '');
        flush();
        out.push({ type: 'br' });
      } else buf += '\n';
      i += 1;
      continue;
    }

    if (ch === '`') {
      const run = /^`+/.exec(rest)![0];
      const close = findTicks(text, i + run.length, run.length);
      if (close >= 0) {
        flush();
        let code = text.slice(i + run.length, close).replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && code.trim() !== '') code = code.slice(1, -1);
        out.push({ type: 'code', text: code });
        i = close + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }

    const auto = AUTOLINK.exec(rest);
    if (auto) {
      flush();
      out.push({ type: 'link', href: auto[1]!, children: [{ type: 'text', text: auto[1]! }] });
      i += auto[0].length;
      continue;
    }

    if ((ch === 'h' || ch === 'H') && !/[A-Za-z0-9]$/.test(buf)) {
      const bare = BARE_URL.exec(rest);
      if (bare) {
        flush();
        out.push({ type: 'link', href: bare[0], children: [{ type: 'text', text: bare[0] }] });
        i += bare[0].length;
        continue;
      }
    }

    if (ch === '!' && text[i + 1] === '[') {
      const link = parseLinkAt(text, i + 1);
      if (link) {
        flush();
        out.push({ type: 'image', alt: plainText(parseInline(link.label, depth + 1)), src: link.href });
        i = link.end;
        continue;
      }
    }

    if (ch === '[') {
      const link = parseLinkAt(text, i);
      if (link) {
        flush();
        const children =
          depth < MAX_DEPTH ? parseInline(link.label, depth + 1) : [{ type: 'text' as const, text: link.label }];
        out.push({ type: 'link', href: link.href, children });
        i = link.end;
        continue;
      }
    }

    if ((ch === '*' || ch === '_' || ch === '~') && depth < MAX_DEPTH) {
      const span = parseEmphasisAt(text, i, buf, depth);
      if (span) {
        flush();
        out.push(span.node);
        i = span.end;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

function findTicks(text: string, from: number, len: number): number {
  const limit = Math.min(text.length, from + INLINE_WINDOW);
  let k = from;
  while (k < limit) {
    const at = text.indexOf('`', k);
    if (at < 0 || at >= limit) return -1;
    let end = at;
    while (text[end] === '`') end += 1;
    if (end - at === len) return at;
    k = end;
  }
  return -1;
}

/** `[label](href "title")` starting at `open` (the `[`); null when it is not a link. */
function parseLinkAt(text: string, open: number): { label: string; href: string; end: number } | null {
  let level = 0;
  let k = open;
  const limit = Math.min(text.length, open + INLINE_WINDOW);
  for (; k < limit; k += 1) {
    const c = text[k];
    if (c === '\\') k += 1;
    else if (c === '[') level += 1;
    else if (c === ']' && (level -= 1) === 0) break;
  }
  if (k >= limit || text[k + 1] !== '(') return null;
  const m = /^\(\s*(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+("[^"]*"|'[^']*'))?\s*\)/.exec(
    text.slice(k + 1),
  );
  if (!m) return null;
  const href = m[1]!.startsWith('<') ? m[1]!.slice(1, -1) : m[1]!;
  return { label: text.slice(open + 1, k), href, end: k + 1 + m[0].length };
}

function parseEmphasisAt(
  text: string,
  at: number,
  before: string,
  depth: number,
): { node: Inline; end: number } | null {
  const ch = text[at]!;
  const run = new RegExp(`^\\${ch}+`).exec(text.slice(at))![0];
  if (ch === '~' && run.length !== 2) return null;
  // `_` inside a word (snake_case) is not emphasis.
  if (ch === '_' && /[A-Za-z0-9]$/.test(before)) return null;
  const after = text[at + run.length];
  if (after === undefined || /\s/.test(after)) return null;
  const len = ch === '~' ? 2 : Math.min(run.length, 3);
  const marker = ch.repeat(len);
  const limit = at + len + INLINE_WINDOW;
  let k = at + len;
  while (k < limit) {
    const close = text.indexOf(marker, k);
    if (close < 0 || close >= limit) return null;
    const prev = text[close - 1]!;
    const next = text[close + len];
    const okEnd =
      close > at + len &&
      !/\s/.test(prev) &&
      prev !== '\\' &&
      (ch !== '_' || next === undefined || !/[A-Za-z0-9]/.test(next)) &&
      (next !== ch || len === 3);
    if (okEnd) {
      const inner = parseInline(text.slice(at + len, close), depth + 1);
      const node: Inline =
        ch === '~'
          ? { type: 'del', children: inner }
          : len === 3
            ? { type: 'strong', children: [{ type: 'em', children: inner }] }
            : { type: len === 2 ? 'strong' : 'em', children: inner };
      return { node, end: close + len };
    }
    k = close + 1;
  }
  return null;
}

/** The visible text of inline nodes (image alt text, link labels). */
export function plainText(nodes: Inline[]): string {
  return nodes
    .map((n) =>
      n.type === 'text' || n.type === 'code'
        ? n.text
        : n.type === 'br'
          ? '\n'
          : n.type === 'image'
            ? n.alt
            : plainText(n.children),
    )
    .join('');
}
