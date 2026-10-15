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
