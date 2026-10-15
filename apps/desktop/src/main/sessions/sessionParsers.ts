// Per-line parsers for agent session logs (JSONL). Pure: each parser folds already
// JSON-decoded lines, so the formats are unit-tested without touching disk.
//
// Formats (as written by the agents themselves, read-only here):
//   Claude Code — ~/.claude/projects/<dashed-cwd>/<sessionId>.jsonl. Lines carry `type`,
//     `sessionId`, `cwd`, `gitBranch`, `timestamp`, `isSidechain`, `isMeta`, `message`.
//     An assistant reply is split into one line PER CONTENT BLOCK, each repeating the same
//     `message.id` and `message.usage` — usage is therefore counted once per message id.
//   Codex — ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Lines are `{timestamp, type,
//     payload}`: `session_meta` (id, cwd), `turn_context` (model), `event_msg` with
//     `payload.type` of `user_message` / `agent_message` / `token_count`, and
//     `response_item` for tool calls. `token_count.info` holds the running
//     `total_token_usage` and the per-response `last_token_usage`; the event is re-emitted
//     without a new response, so a repeat of the same running total is ignored.
//   pi and Cursor — see their sections below.
//
// Unknown or malformed lines are skipped, never fatal: these files belong to other
// programs whose formats change between versions.

import { dayKey } from '../../shared/usageStats';
import type {
  LocalUsageRecord,
  SessionAgentId,
  SessionSummary,
  TranscriptEntry,
} from '../../shared/agentSessions';

/** Cap on a session title (characters). */
export const TITLE_MAX = 120;
/** Cap on one transcript entry's text (characters). */
export const ENTRY_TEXT_MAX = 20_000;
/** Cap on a tool entry's text (characters) — tool payloads are often huge and noisy. */
export const TOOL_TEXT_MAX = 2_000;

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}
function tsOf(v: unknown): number {
  if (typeof v !== 'string') return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

export function oneLine(text: string, max = TITLE_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** A prompt that is harness plumbing rather than something the user typed. */
function isSyntheticPrompt(text: string): boolean {
  const t = text.trimStart();
  return t === '' || t.startsWith('<') || t.startsWith('Caveat:');
}

export interface FileScan {
  summary: SessionSummary | null;
  usage: LocalUsageRecord[];
}

class UsageAccumulator {
  private readonly map = new Map<string, LocalUsageRecord>();
  constructor(private readonly agentId: SessionAgentId) {}

  add(ts: number, model: string, input: number, output: number, cacheRead: number, cacheWrite: number): void {
    if (ts <= 0) return;
    const day = dayKey(ts);
    const key = `${day}\u0000${model}`;
    let r = this.map.get(key);
    if (!r) {
      r = { day, agentId: this.agentId, model, responses: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      this.map.set(key, r);
    }
    r.responses += 1;
    r.inputTokens += input;
    r.outputTokens += output;
    r.cacheReadTokens += cacheRead;
    r.cacheWriteTokens += cacheWrite;
  }

  records(): LocalUsageRecord[] {
    return [...this.map.values()];
  }
}

interface SummaryDraft {
  sessionId: string;
  title: string;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  model: string;
  gitBranch: string;
  messageCount: number;
}

function draft(): SummaryDraft {
  return { sessionId: '', title: '', cwd: '', startedAt: 0, updatedAt: 0, model: '', gitBranch: '', messageCount: 0 };
}

function touch(d: SummaryDraft, ts: number): void {
  if (ts <= 0) return;
  if (d.startedAt === 0 || ts < d.startedAt) d.startedAt = ts;
  if (ts > d.updatedAt) d.updatedAt = ts;
}

function finish(agentId: SessionAgentId, d: SummaryDraft, fallbackId: string): SessionSummary | null {
  const sessionId = d.sessionId || fallbackId;
  if (!sessionId || d.messageCount === 0) return null;
  return { agentId, ...d, sessionId };
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/** Text of a Claude user/assistant `message.content` (string or text blocks). */
function claudeText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const block = obj(b);
      return block && block.type === 'text' ? str(block.text) : '';
    })
    .filter((s) => s !== '')
    .join('\n');
}

export interface ClaudeScanOptions {
  /** Subagent transcripts count toward usage but are not listed as sessions. */
  listAsSession: boolean;
  fallbackId: string;
}

export function scanClaudeLines(lines: Iterable<unknown>, opts: ClaudeScanOptions): FileScan {
  const d = draft();
  const usage = new UsageAccumulator('claude');
  // message.id → last-seen usage for that message (the repeats are identical, but the
  // final block of a streamed reply is the authoritative one).
  const perMessage = new Map<string, { ts: number; model: string; u: Json }>();
  let anonymous = 0;
  let summaryTitle = '';

  for (const raw of lines) {
    const line = obj(raw);
    if (!line) continue;
    const type = str(line.type);
    if (type === 'summary' && !summaryTitle) summaryTitle = str(line.summary);
    const ts = tsOf(line.timestamp);
    if (type !== 'user' && type !== 'assistant') continue;
    touch(d, ts);
    if (!d.sessionId) d.sessionId = str(line.sessionId);
    if (!d.cwd) d.cwd = str(line.cwd);
    const branch = str(line.gitBranch);
    if (branch) d.gitBranch = branch;
    const message = obj(line.message);
    if (!message) continue;

    if (type === 'assistant') {
      const model = str(message.model);
      if (model && model !== '<synthetic>') d.model = model;
      const u = obj(message.usage);
      if (u && model !== '<synthetic>') {
        const id = str(message.id) || `\u0000${anonymous++}`;
        perMessage.set(id, { ts, model: model || 'unknown', u });
      }
      if (claudeText(message.content) !== '' && !line.isSidechain) d.messageCount += 1;
      continue;
    }

    // user
    if (line.isMeta === true || line.isSidechain === true) continue;
    const text = claudeText(message.content);
    if (text === '') continue; // tool_result-only turns
    d.messageCount += 1;
    if (!d.title && !isSyntheticPrompt(text)) d.title = oneLine(text);
  }

  for (const { ts, model, u } of perMessage.values()) {
    usage.add(
      ts,
      model,
      num(u.input_tokens),
      num(u.output_tokens),
      num(u.cache_read_input_tokens),
      num(u.cache_creation_input_tokens),
    );
  }
  if (!d.title && summaryTitle) d.title = oneLine(summaryTitle);
  return {
    summary: opts.listAsSession ? finish('claude', d, opts.fallbackId) : null,
    usage: usage.records(),
  };
}

function toolInputText(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return '';
  }
}

function claudeToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return claudeText(content);
}

export function claudeTranscript(lines: Iterable<unknown>): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  const toolNames = new Map<string, string>();
  for (const raw of lines) {
    const line = obj(raw);
    if (!line || line.isSidechain === true) continue;
    const type = str(line.type);
    if (type !== 'user' && type !== 'assistant') continue;
    const message = obj(line.message);
    if (!message) continue;
    const ts = tsOf(line.timestamp);
    const content = message.content;

    if (type === 'user') {
      if (line.isMeta === true) continue;
      if (typeof content === 'string') {
        if (content.trim()) out.push({ role: 'user', text: clip(content, ENTRY_TEXT_MAX), ts });
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        const block = obj(b);
        if (!block) continue;
        if (block.type === 'text' && str(block.text).trim()) {
          out.push({ role: 'user', text: clip(str(block.text), ENTRY_TEXT_MAX), ts });
        } else if (block.type === 'tool_result') {
          const name = toolNames.get(str(block.tool_use_id));
          out.push({
            role: 'tool',
            text: clip(claudeToolResultText(block.content), TOOL_TEXT_MAX),
            ts,
            ...(name ? { toolName: name } : {}),
          });
        }
      }
      continue;
    }

    if (!Array.isArray(content)) continue;
    for (const b of content) {
      const block = obj(b);
      if (!block) continue;
      if (block.type === 'text' && str(block.text).trim()) {
        out.push({ role: 'assistant', text: clip(str(block.text), ENTRY_TEXT_MAX), ts });
      } else if (block.type === 'tool_use') {
        const name = str(block.name) || 'tool';
        toolNames.set(str(block.id), name);
        out.push({ role: 'tool', text: clip(toolInputText(block.input), TOOL_TEXT_MAX), ts, toolName: name });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export function scanCodexLines(lines: Iterable<unknown>, fallbackId: string): FileScan {
  const d = draft();
  const usage = new UsageAccumulator('codex');
  let lastTotal = -1;

  for (const raw of lines) {
    const line = obj(raw);
    if (!line) continue;
    const ts = tsOf(line.timestamp);
    const payload = obj(line.payload);
    if (!payload) continue;
    const type = str(line.type);

    if (type === 'session_meta') {
      if (!d.sessionId) d.sessionId = str(payload.id);
      if (!d.cwd) d.cwd = str(payload.cwd);
      const git = obj(payload.git);
      if (git && str(git.branch)) d.gitBranch = str(git.branch);
      touch(d, ts || tsOf(payload.timestamp));
      continue;
    }
    if (type === 'turn_context') {
      const model = str(payload.model);
      if (model) d.model = model;
      if (!d.cwd) d.cwd = str(payload.cwd);
      continue;
    }
    if (type !== 'event_msg') continue;
    const kind = str(payload.type);

    if (kind === 'user_message') {
      const text = str(payload.message);
      if (!text.trim()) continue;
      touch(d, ts);
      d.messageCount += 1;
      if (!d.title && !isSyntheticPrompt(text)) d.title = oneLine(text);
    } else if (kind === 'agent_message') {
      if (!str(payload.message).trim()) continue;
      touch(d, ts);
      d.messageCount += 1;
    } else if (kind === 'token_count') {
      const info = obj(payload.info);
      if (!info) continue;
      const total = obj(info.total_token_usage);
      const last = obj(info.last_token_usage);
      if (!last) continue;
      const running = total ? num(total.total_tokens) : -1;
      if (running >= 0 && running === lastTotal) continue;
      lastTotal = running;
      touch(d, ts);
      // `input_tokens` INCLUDES the cached and cache-written prompt tokens.
      const input = num(last.input_tokens);
      const cacheRead = num(last.cached_input_tokens);
      const cacheWrite = num(last.cache_write_input_tokens);
      usage.add(
        ts,
        d.model || 'unknown',
        Math.max(0, input - cacheRead - cacheWrite),
        num(last.output_tokens),
        cacheRead,
        cacheWrite,
      );
    }
  }

  return { summary: finish('codex', d, fallbackId), usage: usage.records() };
}

function codexOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) {
    const o = obj(output);
    return o ? str(o.content) || str(o.output) : '';
  }
  return output
    .map((b) => {
      const block = obj(b);
      return block ? str(block.text) : '';
    })
    .filter((s) => s !== '')
    .join('\n');
}

export function codexTranscript(lines: Iterable<unknown>): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  const toolNames = new Map<string, string>();
  for (const raw of lines) {
    const line = obj(raw);
    const payload = line ? obj(line.payload) : undefined;
    if (!line || !payload) continue;
    const ts = tsOf(line.timestamp);
    const kind = str(payload.type);

    if (line.type === 'event_msg') {
      const text = str(payload.message);
      if (!text.trim()) continue;
      if (kind === 'user_message') out.push({ role: 'user', text: clip(text, ENTRY_TEXT_MAX), ts });
      else if (kind === 'agent_message') out.push({ role: 'assistant', text: clip(text, ENTRY_TEXT_MAX), ts });
      continue;
    }
    if (line.type !== 'response_item') continue;
    if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call') {
      const name = str(payload.name) || (kind === 'local_shell_call' ? 'shell' : 'tool');
      toolNames.set(str(payload.call_id), name);
      const input = kind === 'function_call' ? str(payload.arguments) : toolInputText(payload.input ?? payload.action);
      out.push({ role: 'tool', text: clip(input, TOOL_TEXT_MAX), ts, toolName: name });
    } else if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
      const name = toolNames.get(str(payload.call_id));
      out.push({
        role: 'tool',
        text: clip(codexOutputText(payload.output), TOOL_TEXT_MAX),
        ts,
        ...(name ? { toolName: name } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------
//
// ~/.pi/agent/sessions/--<cwd>--/<timestamp>_<id>.jsonl (documented in pi's
// docs/session-format.md). First line is the header `{type:'session', id, cwd, timestamp}`;
// `message` entries wrap an AgentMessage (`role` user / assistant / toolResult / …),
// `model_change` switches the model, `session_info.name` is the user-set title. Usage
// (`input` already EXCLUDES cache reads / writes) rides on assistant messages, and also on
// `usage`, `compaction` and `branch_summary` entries and on tool results doing nested model
// work — all of it was billed, so all of it counts. Abandoned branches stay in the file and
// are counted too.

/** Text of a pi `content` (string or blocks of `{type:'text', text}`). */
function piText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const block = obj(b);
      return block && block.type === 'text' ? str(block.text) : '';
    })
    .filter((s) => s !== '')
    .join('\n');
}

function addPiUsage(usage: UsageAccumulator, ts: number, model: string, u: Json | undefined): void {
  if (!u) return;
  usage.add(ts, model || 'unknown', num(u.input), num(u.output), num(u.cacheRead), num(u.cacheWrite));
}

export function scanPiLines(lines: Iterable<unknown>, fallbackId: string): FileScan {
  const d = draft();
  const usage = new UsageAccumulator('pi');
  let name = '';

  for (const raw of lines) {
    const line = obj(raw);
    if (!line) continue;
    const type = str(line.type);
    const ts = tsOf(line.timestamp);

    if (type === 'session') {
      if (!d.sessionId) d.sessionId = str(line.id);
      if (!d.cwd) d.cwd = str(line.cwd);
      touch(d, ts);
      continue;
    }
    if (type === 'session_info') {
      name = str(line.name);
      continue;
    }
    if (type === 'model_change') {
      if (str(line.modelId)) d.model = str(line.modelId);
      continue;
    }
    if (type === 'usage') {
      touch(d, ts);
      addPiUsage(usage, ts, str(line.model) || d.model, obj(line.usage));
      continue;
    }
    if (type === 'compaction' || type === 'branch_summary') {
      addPiUsage(usage, ts, d.model, obj(line.usage));
      continue;
    }
    if (type !== 'message') continue;
    const message = obj(line.message);
    if (!message) continue;
    const role = str(message.role);

    if (role === 'user') {
      const text = piText(message.content);
      if (!text.trim()) continue;
      touch(d, ts);
      d.messageCount += 1;
      if (!d.title && !isSyntheticPrompt(text)) d.title = oneLine(text);
    } else if (role === 'assistant') {
      touch(d, ts);
      const model = str(message.model);
      if (model) d.model = model;
      addPiUsage(usage, ts, model || d.model, obj(message.usage));
      if (piText(message.content).trim()) d.messageCount += 1;
    } else if (role === 'toolResult') {
      addPiUsage(usage, ts, d.model, obj(message.usage));
    }
  }

  if (name.trim()) d.title = oneLine(name);
  return { summary: finish('pi', d, fallbackId), usage: usage.records() };
}

export function piTranscript(lines: Iterable<unknown>): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const raw of lines) {
    const line = obj(raw);
    if (!line || line.type !== 'message') continue;
    const message = obj(line.message);
    if (!message) continue;
    const ts = tsOf(line.timestamp);
    const role = str(message.role);

    if (role === 'user') {
      const text = piText(message.content);
      if (text.trim()) out.push({ role: 'user', text: clip(text, ENTRY_TEXT_MAX), ts });
    } else if (role === 'assistant') {
      if (!Array.isArray(message.content)) continue;
      for (const b of message.content) {
        const block = obj(b);
        if (!block) continue;
        if (block.type === 'text' && str(block.text).trim()) {
          out.push({ role: 'assistant', text: clip(str(block.text), ENTRY_TEXT_MAX), ts });
        } else if (block.type === 'toolCall') {
          out.push({ role: 'tool', text: clip(toolInputText(block.arguments), TOOL_TEXT_MAX), ts, toolName: str(block.name) || 'tool' });
        }
      }
    } else if (role === 'toolResult') {
      const name = str(message.toolName);
      out.push({ role: 'tool', text: clip(piText(message.content), TOOL_TEXT_MAX), ts, ...(name ? { toolName: name } : {}) });
    } else if (role === 'bashExecution') {
      const text = `$ ${str(message.command)}\n${str(message.output)}`;
      out.push({ role: 'tool', text: clip(text, TOOL_TEXT_MAX), ts, toolName: 'bash' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cursor (cursor-agent CLI)
// ---------------------------------------------------------------------------
//
// ~/.cursor/chats/<hash>/<chatId>/store.db — SQLite, UNDOCUMENTED (shape inferred from
// real files; everything below is defensive). Tables:
//   meta(key, value)  — key '0', value = hex-encoded JSON {agentId, name, createdAt,
//                       lastUsedModel, latestRootBlobId, mode}
//   blobs(id, data)   — content-addressed (id = sha256 hex of data). A blob is either a
//                       JSON message in the AI SDK shape {role, content: string | parts[]}
//                       or a protobuf node. The root node (latestRootBlobId) lists the
//                       conversation's message blob ids in order as repeated field 1
//                       (32 raw bytes each) and the workspace as a file:// URI in field 9.
// No per-message timestamps and no token usage are stored. Usage is therefore ESTIMATED
// (see `estimateCursorUsage`); the UI labels it as such. The caller reads the database;
// this part is pure.

export interface CursorChatSource {
  /** The `meta` row value (hex-encoded JSON, or plain JSON). */
  meta: string;
  /** Blob bytes by hex id, or null when missing. */
  blob(id: string): Uint8Array | null;
  /** Fallbacks: the chat directory name and the database mtime. */
  fallbackId: string;
  mtimeMs: number;
}

function decodeMeta(value: string): Json | undefined {
  const text = /^(?:[0-9a-f]{2})+$/i.test(value) ? Buffer.from(value, 'hex').toString('utf8') : value;
  try {
    return obj(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Minimal protobuf reader: the top-level fields of one message, or null when malformed. */
export function protobufFields(buf: Uint8Array): Array<{ field: number; value: number | Uint8Array }> | null {
  const out: Array<{ field: number; value: number | Uint8Array }> = [];
  let i = 0;
  const varint = (): number | null => {
    let result = 0;
    let mul = 1;
    for (let n = 0; n < 10; n++) {
      if (i >= buf.length) return null;
      const b = buf[i++]!;
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
    return null;
  };
  while (i < buf.length) {
    const tag = varint();
    if (tag === null) return null;
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 0) return null;
    if (wire === 0) {
      const v = varint();
      if (v === null) return null;
      out.push({ field, value: v });
    } else if (wire === 2) {
      const len = varint();
      if (len === null || i + len > buf.length) return null;
      out.push({ field, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 1 || wire === 5) {
      i += wire === 1 ? 8 : 4;
      if (i > buf.length) return null;
    } else {
      return null;
    }
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** file:///a/b → /a/b (Windows: file:///C:/a → C:\a). '' when not a file URI. */
function fileUriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return '';
  try {
    const pathname = decodeURIComponent(new URL(uri).pathname);
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1).replace(/\//g, '\\') : pathname;
  } catch {
    return '';
  }
}

interface CursorMessage {
  role: string;
  content: unknown;
  /** providerOptions.cursor.modelName on the message or its first part that has one. */
  model: string;
}

function cursorModelOf(m: Json): string {
  const own = str(obj(obj(m.providerOptions)?.cursor)?.modelName);
  if (own || !Array.isArray(m.content)) return own;
  for (const p of m.content) {
    const name = str(obj(obj(obj(p)?.providerOptions)?.cursor)?.modelName);
    if (name) return name;
  }
  return '';
}

interface CursorChat {
  meta: Json;
  cwd: string;
  messages: CursorMessage[];
  /** Root field 5.1: the context size Cursor last measured (tokens), 0 when absent. */
  contextTokens: number;
}

function cursorChat(src: CursorChatSource): CursorChat | null {
  const meta = decodeMeta(src.meta);
  if (!meta) return null;
  const rootId = str(meta.latestRootBlobId);
  const root = rootId ? src.blob(rootId) : null;
  const fields = root ? protobufFields(root) : null;
  const messages: CursorMessage[] = [];
  let cwd = '';
  let contextTokens = 0;
  for (const { field, value } of fields ?? []) {
    if (typeof value === 'number') continue;
    if (field === 5 && contextTokens === 0) {
      const used = protobufFields(value)?.find((f) => f.field === 1)?.value;
      if (typeof used === 'number') contextTokens = used;
    }
    if (field === 9 && !cwd) cwd = fileUriToPath(Buffer.from(value).toString('utf8'));
    if (field !== 1 || value.length !== 32) continue;
    const data = src.blob(hex(value));
    if (!data || data[0] !== 0x7b /* { */) continue;
    try {
      const m = obj(JSON.parse(Buffer.from(data).toString('utf8')));
      if (m) messages.push({ role: str(m.role), content: m.content, model: cursorModelOf(m) });
    } catch {
      // not a JSON message — skip
    }
  }
  return { meta, cwd, messages, contextTokens };
}

/**
 * Rough token count of a text: ~1 token per CJK / kana / hangul character, ~4 characters
 * per token otherwise. Exported for tests.
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) wide += 1;
  }
  const narrow = text.length - wide;
  return Math.ceil(wide + narrow / 4);
}

/** Everything in a Cursor message that the model reads or writes, as text. */
function cursorContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const p of content) {
    const part = obj(p);
    if (!part) continue;
    if (typeof part.text === 'string') out.push(part.text);
    else if (part.type === 'tool-call') out.push(str(part.toolName), JSON.stringify(part.args ?? part.input ?? null));
    else if (part.type === 'tool-result') {
      const r = part.result ?? part.output;
      out.push(typeof r === 'string' ? r : JSON.stringify(r ?? null));
    }
  }
  return out.join('\n');
}

/**
 * ESTIMATED usage for a Cursor chat. Cursor keeps the messages but no token counts or
 * timestamps, so:
 *   - every assistant message is one model response; its output is the size of what it
 *     wrote (text, reasoning, tool calls);
 *   - its prompt is everything before it, plus a fixed per-chat overhead (tool schemas,
 *     rules, server-side context — invisible locally) calibrated so that the estimated
 *     final context equals the context size Cursor itself recorded;
 *   - the part of that prompt already sent with the previous response counts as a cache
 *     read (agent loops resend the same prefix), the rest as fresh input;
 *   - responses are spread evenly between the chat's creation and its last write.
 */
export function estimateCursorUsage(chat: CursorChat, created: number, updated: number, fallbackModel: string): LocalUsageRecord[] {
  const sizes = chat.messages.map((m) => estimateTokens(cursorContentText(m.content)));
  const visible = sizes.reduce((a, b) => a + b, 0);
  const overhead = Math.max(0, chat.contextTokens - visible);
  const replies = chat.messages.flatMap((m, i) => (m.role === 'assistant' ? [i] : []));
  if (replies.length === 0) return [];
  const start = created > 0 ? created : updated;
  const span = Math.max(0, updated - start);
  const usage = new UsageAccumulator('cursor');
  let before = 0; // tokens of messages[0 .. i)
  let cursor = 0;
  let previousPrompt = 0;
  replies.forEach((i, n) => {
    while (cursor < i) before += sizes[cursor++]!;
    const prompt = overhead + before;
    const cached = Math.min(previousPrompt, prompt);
    const ts = Math.round(start + (span * (n + 1)) / replies.length);
    usage.add(ts, chat.messages[i]!.model || fallbackModel || 'unknown', prompt - cached, sizes[i]!, cached, 0);
    previousPrompt = prompt + sizes[i]!;
  });
  return usage.records();
}

/** The user's own words in a Cursor user message ('' for injected context). */
function cursorUserText(content: unknown): string {
  const text = piText(content);
  const queries = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)].map((m) => m[1]!);
  if (queries.length > 0) return queries.join('\n');
  return isSyntheticPrompt(text) ? '' : text;
}

export function scanCursorChat(src: CursorChatSource): FileScan {
  const chat = cursorChat(src);
  if (!chat) return { summary: null, usage: [] };
  const { meta, cwd, messages } = chat;
  const d = draft();
  d.sessionId = str(meta.agentId);
  d.cwd = cwd;
  d.model = str(meta.lastUsedModel);
  const created = typeof meta.createdAt === 'number' && Number.isFinite(meta.createdAt) ? meta.createdAt : 0;
  touch(d, created);
  touch(d, Math.floor(src.mtimeMs));
  for (const m of messages) {
    if (m.role === 'user') {
      const text = cursorUserText(m.content);
      if (!text.trim()) continue;
      d.messageCount += 1;
      if (!d.title) d.title = oneLine(text);
    } else if (m.role === 'assistant' && piText(m.content).trim()) {
      d.messageCount += 1;
    }
  }
  if (str(meta.name).trim()) d.title = oneLine(str(meta.name));
  const summary = finish('cursor', d, src.fallbackId);
  const usage = summary ? estimateCursorUsage(chat, created, Math.floor(src.mtimeMs), d.model) : [];
  return { summary, usage };
}

export function cursorTranscript(src: CursorChatSource): TranscriptEntry[] {
  const chat = cursorChat(src);
  if (!chat) return [];
  const out: TranscriptEntry[] = [];
  for (const m of chat.messages) {
    if (m.role === 'user') {
      const text = cursorUserText(m.content);
      if (text.trim()) out.push({ role: 'user', text: clip(text, ENTRY_TEXT_MAX), ts: 0 });
      continue;
    }
    if (!Array.isArray(m.content)) {
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
        out.push({ role: 'assistant', text: clip(m.content, ENTRY_TEXT_MAX), ts: 0 });
      }
      continue;
    }
    for (const p of m.content) {
      const part = obj(p);
      if (!part) continue;
      if (m.role === 'assistant' && part.type === 'text' && str(part.text).trim()) {
        out.push({ role: 'assistant', text: clip(str(part.text), ENTRY_TEXT_MAX), ts: 0 });
      } else if (part.type === 'tool-call') {
        out.push({ role: 'tool', text: clip(toolInputText(part.args ?? part.input), TOOL_TEXT_MAX), ts: 0, toolName: str(part.toolName) || 'tool' });
      } else if (part.type === 'tool-result') {
        const result = part.result ?? part.output;
        const name = str(part.toolName);
        out.push({ role: 'tool', text: clip(typeof result === 'string' ? result : toolInputText(result), TOOL_TEXT_MAX), ts: 0, ...(name ? { toolName: name } : {}) });
      }
    }
  }
  return out;
}
