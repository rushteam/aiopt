// Agent session logs — shared types + pure helpers for reading the transcripts that
// coding agents (Claude Code, Codex, Cursor, pi) already keep on disk. Cursor stores no
// token counts; its usage is estimated from the conversation text.
//
// Two views are built on the same READ-ONLY scan, done main-side:
//   - Local usage: token counts per agent / model / day, read from the numeric usage
//     fields of each logged response. This covers DIRECT bindings, which never pass
//     through the translation proxy and so are invisible to the proxy usage log.
//   - Sessions: a list of past conversations plus, on explicit request, one transcript.
//
// PRIVACY: the usage view carries counts + identifiers only. Session titles and
// transcripts are the user's own conversation text and are shown on request; main
// never logs them and never writes anything back into an agent's directory.
//
// No I/O, no Electron.

import { shiftDayKey } from './usageStats';

/** Agents whose on-disk session logs AiOpt can read. */
export const SESSION_AGENT_IDS = ['claude', 'codex', 'cursor', 'pi'] as const;
export type SessionAgentId = (typeof SESSION_AGENT_IDS)[number];

export function isSessionAgentId(value: unknown): value is SessionAgentId {
  return typeof value === 'string' && (SESSION_AGENT_IDS as readonly string[]).includes(value);
}

/** Session ids are UUIDs in both agents; accept the general shape, nothing path-like. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

export interface SessionSummary {
  agentId: SessionAgentId;
  sessionId: string;
  /** First user prompt (or the agent's own summary), single line, truncated. May be ''. */
  title: string;
  /** Working directory the session ran in ('' when unknown). */
  cwd: string;
  /** Epoch ms of the first / last logged line (0 when unknown). */
  startedAt: number;
  updatedAt: number;
  /** Last model seen in the session ('' when unknown). */
  model: string;
  gitBranch: string;
  /** User + assistant text messages (tool traffic not counted). */
  messageCount: number;
}

export interface SessionsSnapshot {
  /** Newest first. */
  sessions: SessionSummary[];
  scannedAt: number;
  /** True when more log files existed than the scan limit allows. */
  truncated: boolean;
}

export type TranscriptRole = 'user' | 'assistant' | 'tool';

export interface TranscriptEntry {
  role: TranscriptRole;
  /** Plain text; never interpreted as HTML / Markdown by the renderer. */
  text: string;
  /** Epoch ms (0 when unknown). */
  ts: number;
  /** Tool name for a tool call / result entry. */
  toolName?: string;
}

export interface SessionTranscript {
  session: SessionSummary;
  entries: TranscriptEntry[];
  /** True when entries or entry text were cut to stay within the size limit. */
  truncated: boolean;
}

export interface SessionRef {
  agentId: SessionAgentId;
  sessionId: string;
}

export interface SessionsExportResult {
  /** False when the user cancelled the save dialog. */
  saved: boolean;
}

/** Messages picked from a session's transcript, for a context pack (shared/sessionContextPack.ts). */
export interface SessionPackRequest extends SessionRef {
  /** Indexes into the `entries` of the transcript the renderer was shown. */
  indexes: number[];
  /** That transcript's `entries.length` and first entry `ts` — main refuses if it moved since. */
  total: number;
  firstTs: number;
}

export interface SessionPackResult {
  /** False when the user cancelled the save dialog (export only). */
  saved: boolean;
  /** Messages in the pack, and whether older picks were left out to fit the size cap. */
  included: number;
  cut: boolean;
}

// ---------------------------------------------------------------------------
// Local usage
// ---------------------------------------------------------------------------

export interface LocalUsageTotals {
  /** Logged model responses. */
  responses: number;
  /** Input tokens NOT served from cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** input + output + cache read + cache write. */
  totalTokens: number;
}

/** One (day, agent, model) roll-up produced by the scanner. */
export interface LocalUsageRecord extends Omit<LocalUsageTotals, 'totalTokens'> {
  /** 'YYYY-MM-DD' in the system time zone. */
  day: string;
  agentId: SessionAgentId;
  model: string;
}

export interface LocalUsageBucket extends LocalUsageTotals {
  key: string;
}

export interface LocalUsageDailyPoint extends LocalUsageTotals {
  day: string;
}

export interface LocalUsageSnapshot {
  totals: LocalUsageTotals;
  byAgent: LocalUsageBucket[];
  byModel: LocalUsageBucket[];
  daily: LocalUsageDailyPoint[];
  scannedAt: number;
  retentionDays: number;
  /** Log files that contributed at least one response inside the window. */
  sessionCount: number;
}

export function emptyLocalUsageTotals(): LocalUsageTotals {
  return { responses: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
}

function addRecord(t: LocalUsageTotals, r: LocalUsageRecord): void {
  t.responses += r.responses;
  t.inputTokens += r.inputTokens;
  t.outputTokens += r.outputTokens;
  t.cacheReadTokens += r.cacheReadTokens;
  t.cacheWriteTokens += r.cacheWriteTokens;
  t.totalTokens += r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
}

function into(map: Map<string, LocalUsageTotals>, key: string, r: LocalUsageRecord): void {
  let t = map.get(key);
  if (!t) {
    t = emptyLocalUsageTotals();
    map.set(key, t);
  }
  addRecord(t, r);
}

function buckets(map: Map<string, LocalUsageTotals>): LocalUsageBucket[] {
  return [...map.entries()]
    .map(([key, t]) => ({ key, ...t }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.responses - a.responses || a.key.localeCompare(b.key));
}

/**
 * Fold per-file usage records into a snapshot, keeping only days inside the retention
 * window ending at `now`. `perFile` groups records by the log file they came from so the
 * session count can be reported. Pure.
 */
export function aggregateLocalUsage(
  perFile: ReadonlyArray<readonly LocalUsageRecord[]>,
  opts: { now: number; retentionDays: number },
): LocalUsageSnapshot {
  const cutoffDay = shiftDayKey(opts.now, -(opts.retentionDays - 1));
  const totals = emptyLocalUsageTotals();
  const byAgent = new Map<string, LocalUsageTotals>();
  const byModel = new Map<string, LocalUsageTotals>();
  const byDay = new Map<string, LocalUsageTotals>();
  let sessionCount = 0;
  for (const records of perFile) {
    let counted = false;
    for (const r of records) {
      if (r.day < cutoffDay || r.responses === 0) continue;
      counted = true;
      addRecord(totals, r);
      into(byAgent, r.agentId, r);
      into(byModel, r.model || 'unknown', r);
      into(byDay, r.day, r);
    }
    if (counted) sessionCount += 1;
  }
  return {
    totals,
    byAgent: buckets(byAgent),
    byModel: buckets(byModel),
    daily: [...byDay.entries()].map(([day, t]) => ({ day, ...t })).sort((a, b) => a.day.localeCompare(b.day)),
    scannedAt: opts.now,
    retentionDays: opts.retentionDays,
    sessionCount,
  };
}

// ---------------------------------------------------------------------------
// Resume command + Markdown export
// ---------------------------------------------------------------------------

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const RESUME_CLI: Record<SessionAgentId, (id: string) => string> = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
  cursor: (id) => `cursor-agent --resume ${id}`,
  pi: (id) => `pi --session ${id}`,
};

/**
 * The shell command that reopens a session in its agent CLI, prefixed with a `cd` into
 * the session's working directory when one is known. POSIX shells on macOS / Linux;
 * PowerShell syntax on Windows (a cwd that cannot be quoted safely there is left out).
 */
export function resumeCommand(
  ref: SessionRef,
  cwd: string,
  platform: string,
): string {
  if (!isSessionId(ref.sessionId)) throw new Error('invalid session id');
  const cli = RESUME_CLI[ref.agentId](ref.sessionId);
  if (!cwd || /[\r\n\u0000]/.test(cwd)) return cli;
  if (platform === 'win32') {
    if (/["`$]/.test(cwd)) return cli;
    return `Set-Location -LiteralPath "${cwd}"; ${cli}`;
  }
  return `cd ${posixQuote(cwd)} && ${cli}`;
}

/** A code fence longer than any backtick run inside `text`. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

const ROLE_HEADING: Record<TranscriptRole, string> = { user: 'User', assistant: 'Assistant', tool: 'Tool' };

/** Render a transcript as a self-contained Markdown document. Tool traffic goes in fences. */
export function transcriptToMarkdown(transcript: SessionTranscript): string {
  const { session } = transcript;
  const lines: string[] = [];
  lines.push(`# ${session.title || session.sessionId}`, '');
  lines.push(`- Agent: ${session.agentId}`);
  lines.push(`- Session: ${session.sessionId}`);
  if (session.cwd) lines.push(`- Directory: ${session.cwd}`);
  if (session.model) lines.push(`- Model: ${session.model}`);
  if (session.startedAt) lines.push(`- Started: ${new Date(session.startedAt).toISOString()}`);
  if (transcript.truncated) lines.push('- Note: this transcript was shortened.');
  lines.push('');
  for (const e of transcript.entries) {
    const heading = e.role === 'tool' && e.toolName ? `${ROLE_HEADING.tool}: ${e.toolName}` : ROLE_HEADING[e.role];
    lines.push(`## ${heading}`, '');
    if (e.role === 'tool') {
      const fence = fenceFor(e.text);
      lines.push(fence, e.text, fence);
    } else {
      lines.push(e.text);
    }
    lines.push('');
  }
  return lines.join('\n');
}
