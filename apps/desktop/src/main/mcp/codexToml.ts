// Codex keeps MCP servers in config.toml as `[mcp_servers.<name>]` tables (plus optional
// `[mcp_servers.<name>.env]` / `.http_headers` sub-tables). AiOpt has no TOML dependency, so
// this is a LINE-LEVEL splitter: it cuts the document at table headers and treats every
// `mcp_servers` table as an opaque block. That lets two writers share one file:
//   - the binding adapter rewrites everything else and carries the MCP blocks over verbatim;
//   - the MCP writer replaces only the blocks for names it manages.
// A small value reader (strings, string arrays, inline tables of strings) recovers enough of
// a block for import and drift checks. Anything it cannot read is left untouched.

import { tomlString, tomlTableHeader } from '../providers/tomlLite';

interface Block {
  /** `null` for the root (pre-header) part; otherwise the parsed header path. */
  path: string[] | null;
  lines: string[];
}

/** Parse a `[a.b."c d"]` header line into its key path, or null if it is not a table header. */
export function parseTableHeader(line: string): string[] | null {
  const m = line.match(/^\s*\[(?!\[)(.*)\]\s*(#.*)?$/);
  if (!m) return null;
  const out: string[] = [];
  let rest = m[1]!.trim();
  while (rest !== '') {
    let seg: string;
    if (rest.startsWith('"')) {
      const end = findStringEnd(rest, '"');
      if (end < 0) return null;
      seg = JSON.parse(rest.slice(0, end + 1)) as string;
      rest = rest.slice(end + 1).trim();
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end < 0) return null;
      seg = rest.slice(1, end);
      rest = rest.slice(end + 1).trim();
    } else {
      const bm = rest.match(/^[A-Za-z0-9_-]+/);
      if (!bm) return null;
      seg = bm[0];
      rest = rest.slice(seg.length).trim();
    }
    out.push(seg);
    if (rest.startsWith('.')) rest = rest.slice(1).trim();
    else if (rest !== '') return null;
  }
  return out.length > 0 ? out : null;
}

function findStringEnd(s: string, quote: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === quote) return i;
  }
  return -1;
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [{ path: null, lines: [] }];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const header = /^\s*\[/.test(line) ? parseTableHeader(line) : null;
    // `[[array.of.tables]]` and unparseable headers start an opaque non-MCP block.
    if (header || /^\s*\[/.test(line)) blocks.push({ path: header ?? ['\u0000opaque'], lines: [line] });
    else blocks[blocks.length - 1]!.lines.push(line);
  }
  return blocks;
}

function isMcpBlock(b: Block): boolean {
  return b.path !== null && b.path[0] === 'mcp_servers' && b.path.length >= 2;
}

/** The raw `[mcp_servers.*]` blocks of a document, joined, for the adapter to carry over. */
export function extractMcpBlocks(text: string): string {
  const kept = splitBlocks(text).filter(isMcpBlock);
  return trimJoin(kept.map((b) => trimTrailingBlank(b.lines).join('\n')));
}

/** The document with every `[mcp_servers.*]` block removed. */
export function stripMcpBlocks(text: string): string {
  const kept = splitBlocks(text).filter((b) => !isMcpBlock(b));
  return trimJoin(kept.map((b) => trimTrailingBlank(b.lines).join('\n')));
}

/** Replace the blocks of `names` with `rendered` (already-rendered TOML), keeping all else. */
export function replaceMcpBlocks(text: string, names: ReadonlySet<string>, rendered: string): string {
  const kept = splitBlocks(text).filter((b) => !(isMcpBlock(b) && names.has(b.path![1]!)));
  const body = trimJoin(kept.map((b) => trimTrailingBlank(b.lines).join('\n')));
  const parts = [body, rendered.trim()].filter((p) => p !== '');
  return parts.length === 0 ? '' : `${parts.join('\n\n')}\n`;
}

function trimTrailingBlank(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
  return out;
}

function trimJoin(parts: string[]): string {
  return parts.filter((p) => p.trim() !== '').join('\n\n');
}

/** What the reader recovers from one server's blocks. Unknown keys are ignored. */
export interface CodexMcpEntry {
  command?: string;
  args?: string[];
  url?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  /**
   * Lines AiOpt does not model (e.g. `startup_timeout_sec = 30`, `enabled = false`), and
   * whole sub-tables other than env/http_headers. Carried over verbatim on rewrite so a
   * user's tuning survives; ignored when comparing.
   */
  extraLines: string[];
  extraBlocks: string[];
}

/** Every `mcp_servers.<name>` entry in the document, by name. */
export function readCodexMcpServers(text: string): Map<string, CodexMcpEntry> {
  const out = new Map<string, CodexMcpEntry>();
  const get = (name: string): CodexMcpEntry => {
    let e = out.get(name);
    if (!e) out.set(name, (e = { env: {}, headers: {}, extraLines: [], extraBlocks: [] }));
    return e;
  };
  for (const b of splitBlocks(text).filter(isMcpBlock)) {
    const name = b.path![1]!;
    const sub = b.path!.slice(2).join('.');
    const entry = get(name);
    if (sub !== '' && sub !== 'env' && sub !== 'http_headers') {
      entry.extraBlocks.push(trimTrailingBlank(b.lines).join('\n'));
      continue;
    }
    for (const [key, raw] of keyValues(b.lines.slice(1))) {
      const value = readValue(raw);
      if (sub === '') {
        if (key === 'command' && typeof value === 'string') entry.command = value;
        else if (key === 'url' && typeof value === 'string') entry.url = value;
        else if (key === 'args' && Array.isArray(value)) entry.args = value;
        else if ((key === 'env' || key === 'http_headers') && isStringMap(value)) {
          Object.assign(key === 'env' ? entry.env : entry.headers, value);
        } else entry.extraLines.push(`${tomlKey(key)} = ${raw.trim()}`);
      } else if (typeof value === 'string') {
        (sub === 'env' ? entry.env : entry.headers)[key] = value;
      }
    }
  }
  return out;
}

function isStringMap(v: unknown): v is Record<string, string> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** `key = value` pairs of a block body; a value may span lines (an array). */
function keyValues(lines: string[]): [string, string][] {
  const out: [string, string][] = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i]!.match(/^\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    i++;
    if (!m) continue;
    const key = m[1]!.startsWith('"') ? (JSON.parse(m[1]!) as string) : m[1]!;
    let raw = m[2]!;
    while (!balanced(raw) && i < lines.length) raw += `\n${lines[i++]}`;
    out.push([key, raw]);
  }
  return out;
}

function balanced(raw: string): boolean {
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"' || c === "'") {
      const end = c === '"' ? findStringEnd(raw.slice(i), '"') : raw.indexOf("'", i + 1) - i;
      if (end < 0) return false;
      i += end;
    } else if (c === '#') break;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

/** Strings, booleans (as 'true'/'false'), string arrays and inline string tables; else undefined. */
function readValue(raw: string): string | string[] | Record<string, string> | undefined {
  const r = new Reader(raw);
  const v = r.value();
  return r.ok && r.atEnd() ? v : undefined;
}

class Reader {
  i = 0;
  ok = true;
  constructor(private readonly s: string) {}

  private skip(): void {
    for (;;) {
      while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
      if (this.s[this.i] === '#') {
        while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
      } else return;
    }
  }

  atEnd(): boolean {
    this.skip();
    return this.i >= this.s.length;
  }

  value(): string | string[] | Record<string, string> | undefined {
    this.skip();
    const c = this.s[this.i];
    if (c === '"' || c === "'") return this.str();
    if (c === '[') return this.list();
    if (c === '{') return this.table();
    const m = this.s.slice(this.i).match(/^(true|false)\b/);
    if (m) {
      this.i += m[0].length;
      return m[0];
    }
    this.ok = false;
    return undefined;
  }

  private str(): string | undefined {
    const rest = this.s.slice(this.i);
    if (rest.startsWith('"""') || rest.startsWith("'''")) {
      this.ok = false;
      return undefined;
    }
    if (rest[0] === "'") {
      const end = rest.indexOf("'", 1);
      if (end < 0) return this.fail();
      this.i += end + 1;
      return rest.slice(1, end);
    }
    const end = findStringEnd(rest, '"');
    if (end < 0) return this.fail();
    this.i += end + 1;
    try {
      // TOML basic-string escapes are a superset of JSON's only for \U and \e; those fail here.
      return JSON.parse(rest.slice(0, end + 1)) as string;
    } catch {
      return this.fail();
    }
  }

  private list(): string[] | undefined {
    this.i++;
    const out: string[] = [];
    for (;;) {
      this.skip();
      if (this.s[this.i] === ']') {
        this.i++;
        return out;
      }
      const v = this.value();
      if (!this.ok || typeof v !== 'string') return this.fail();
      out.push(v);
      this.skip();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== ']') return this.fail();
    }
  }

  private table(): Record<string, string> | undefined {
    this.i++;
    const out: Record<string, string> = {};
    for (;;) {
      this.skip();
      if (this.s[this.i] === '}') {
        this.i++;
        return out;
      }
      let key: string | undefined;
      if (this.s[this.i] === '"' || this.s[this.i] === "'") key = this.str();
      else {
        const m = this.s.slice(this.i).match(/^[A-Za-z0-9_-]+/);
        if (m) {
          key = m[0];
          this.i += key.length;
        }
      }
      this.skip();
      if (key === undefined || this.s[this.i] !== '=') return this.fail();
      this.i++;
      const v = this.value();
      if (!this.ok || typeof v !== 'string') return this.fail();
      out[key] = v;
      this.skip();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== '}') return this.fail();
    }
  }

  private fail(): undefined {
    this.ok = false;
    return undefined;
  }
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/**
 * Render one server as Codex TOML. Env/headers go in sub-tables, sorted for stable output;
 * `keep` (from the live entry) carries the user's unmodelled lines and sub-tables over.
 */
export function renderCodexMcpServer(
  name: string,
  spec: { command?: string; args?: string[]; url?: string; env: Record<string, string>; headers: Record<string, string> },
  keep: { extraLines: string[]; extraBlocks: string[] } = { extraLines: [], extraBlocks: [] },
): string {
  const lines = [tomlTableHeader('mcp_servers', name)];
  if (spec.url !== undefined) lines.push(`url = ${tomlString(spec.url)}`);
  else {
    lines.push(`command = ${tomlString(spec.command ?? '')}`);
    if (spec.args && spec.args.length > 0) lines.push(`args = [${spec.args.map(tomlString).join(', ')}]`);
  }
  lines.push(...keep.extraLines);
  for (const [sub, map] of [
    ['env', spec.env],
    ['http_headers', spec.headers],
  ] as const) {
    const keys = Object.keys(map).sort();
    if (keys.length === 0) continue;
    lines.push('', tomlTableHeader('mcp_servers', name, sub));
    for (const k of keys) lines.push(`${tomlKey(k)} = ${tomlString(map[k]!)}`);
  }
  for (const block of keep.extraBlocks) lines.push('', block);
  return lines.join('\n');
}
