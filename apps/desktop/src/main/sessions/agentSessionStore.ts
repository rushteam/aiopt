// Agent session store — the main-side, READ-ONLY scan of agent session logs.
//
// Feeds two renderer views: local usage (token counts, covering direct bindings the
// proxy never sees) and the sessions list / transcript reader. Paths are built here from
// the agent home and the fixed per-agent layout; the renderer names a session only by
// (agentId, sessionId), which is looked up in the index built by the last scan — a path
// never crosses IPC in either direction.
//
// Safety:
//   - Nothing is ever written inside an agent directory.
//   - Symlinks are not followed (directory entries must be real files / dirs).
//   - Files over FILE_MAX_BYTES are skipped; at most FILES_MAX files are parsed per scan.
//   - Unchanged files (same size + mtime) reuse their cached parse, so a rescan is cheap.
//   - Session text is never logged; logs carry counts and masked paths only.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { logger, maskPath } from '../logger';
import { throwIpcError } from '../ipc/validate';
import { USAGE_RETENTION_DAYS } from '../../shared/usageStats';
import {
  aggregateLocalUsage,
  type LocalUsageSnapshot,
  type SessionAgentId,
  type SessionRef,
  type SessionSummary,
  type SessionsSnapshot,
  type SessionTranscript,
  type TranscriptEntry,
} from '../../shared/agentSessions';
import {
  claudeTranscript,
  codexTranscript,
  scanClaudeLines,
  scanCodexLines,
  type FileScan,
} from './sessionParsers';

const log = logger.child('sessions');

export const FILE_MAX_BYTES = 64 * 1024 * 1024;
export const FILES_MAX = 3000;
/** Upper bound on transcript entries returned to the renderer. */
export const TRANSCRIPT_ENTRIES_MAX = 2000;
/** A rescan is skipped when the last one finished less than this long ago. */
const RESCAN_MIN_INTERVAL_MS = 5_000;

export interface AgentSessionStore {
  sessions(opts?: { refresh?: boolean }): Promise<SessionsSnapshot>;
  localUsage(opts?: { refresh?: boolean }): Promise<LocalUsageSnapshot>;
  transcript(ref: SessionRef): Promise<SessionTranscript>;
  /** The summary for a session from the last scan (scans once if needed). */
  find(ref: SessionRef): Promise<SessionSummary>;
}

export interface AgentSessionStoreDeps {
  /** The agent home (normally the user's home directory). */
  home: () => string;
  now?: () => number;
}

interface LogFile {
  agentId: SessionAgentId;
  file: string;
  size: number;
  mtimeMs: number;
  /** Claude subagent transcripts: usage only, not listed. */
  usageOnly: boolean;
  fallbackId: string;
}

interface CachedScan {
  size: number;
  mtimeMs: number;
  scan: FileScan;
}

function* jsonLines(text: string): Generator<unknown> {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (line === '') continue;
    try {
      yield JSON.parse(line);
    } catch {
      // A torn final line (agent still writing) or a format change — skip it.
    }
  }
}

async function readDirents(dir: string) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function statFile(file: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await fsp.lstat(file);
    if (!st.isFile()) return null;
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

async function addFile(
  out: LogFile[],
  agentId: SessionAgentId,
  file: string,
  usageOnly: boolean,
  fallbackId: string,
): Promise<void> {
  const st = await statFile(file);
  if (!st || st.size === 0 || st.size > FILE_MAX_BYTES) return;
  out.push({ agentId, file, usageOnly, fallbackId, ...st });
}

/** ~/.claude/projects/<project>/<id>.jsonl and <project>/<id>/subagents/*.jsonl */
async function listClaude(home: string, out: LogFile[]): Promise<void> {
  const root = path.join(home, '.claude', 'projects');
  for (const project of await readDirents(root)) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    for (const entry of await readDirents(projectDir)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        await addFile(out, 'claude', path.join(projectDir, entry.name), false, entry.name.slice(0, -'.jsonl'.length));
      } else if (entry.isDirectory()) {
        const subDir = path.join(projectDir, entry.name, 'subagents');
        for (const sub of await readDirents(subDir)) {
          if (sub.isFile() && sub.name.endsWith('.jsonl')) {
            await addFile(out, 'claude', path.join(subDir, sub.name), true, '');
          }
        }
      }
    }
  }
}

/** ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl */
async function listCodex(home: string, out: LogFile[]): Promise<void> {
  const root = path.join(home, '.codex', 'sessions');
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readDirents(dir)) {
      const full = path.join(dir, entry.name);
      if (depth < 3) {
        if (entry.isDirectory()) await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        await addFile(out, 'codex', full, false, '');
      }
    }
  };
  await walk(root, 0);
}

function parse(f: LogFile, text: string): FileScan {
  return f.agentId === 'claude'
    ? scanClaudeLines(jsonLines(text), { listAsSession: !f.usageOnly, fallbackId: f.fallbackId })
    : scanCodexLines(jsonLines(text), f.fallbackId);
}

export function createAgentSessionStore(deps: AgentSessionStoreDeps): AgentSessionStore {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, CachedScan>();
  /** `${agentId}:${sessionId}` → file, from the last scan. */
  let index = new Map<string, string>();
  let lastScan: { at: number; files: LogFile[]; truncated: boolean } | null = null;
  let inFlight: Promise<void> | null = null;

  const key = (agentId: string, sessionId: string) => `${agentId}:${sessionId}`;

  async function scan(): Promise<void> {
    const started = now();
    const home = deps.home();
    const all: LogFile[] = [];
    await listClaude(home, all);
    await listCodex(home, all);
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const files = all.slice(0, FILES_MAX);

    const seen = new Set<string>();
    const nextIndex = new Map<string, string>();
    let parsed = 0;
    for (const f of files) {
      seen.add(f.file);
      let hit = cache.get(f.file);
      if (!hit || hit.size !== f.size || hit.mtimeMs !== f.mtimeMs) {
        let text: string;
        try {
          text = await fsp.readFile(f.file, 'utf8');
        } catch {
          continue;
        }
        hit = { size: f.size, mtimeMs: f.mtimeMs, scan: parse(f, text) };
        cache.set(f.file, hit);
        parsed += 1;
      }
      const s = hit.scan.summary;
      if (s) nextIndex.set(key(s.agentId, s.sessionId), f.file);
    }
    for (const file of [...cache.keys()]) if (!seen.has(file)) cache.delete(file);
    index = nextIndex;
    lastScan = { at: now(), files, truncated: all.length > files.length };
    log.info('sessions.scanned', {
      files: files.length,
      parsed,
      truncated: all.length > files.length,
      ms: now() - started,
      home: maskPath(home),
    });
  }

  async function ensureScanned(refresh: boolean): Promise<NonNullable<typeof lastScan>> {
    const fresh = lastScan && now() - lastScan.at < RESCAN_MIN_INTERVAL_MS;
    if (!lastScan || (refresh && !fresh)) {
      if (!inFlight) {
        inFlight = scan().finally(() => {
          inFlight = null;
        });
      }
      await inFlight;
    }
    return lastScan!;
  }

  async function find(ref: SessionRef): Promise<SessionSummary> {
    await ensureScanned(false);
    let file = index.get(key(ref.agentId, ref.sessionId));
    if (!file) {
      // The session may be newer than the last scan.
      await ensureScanned(true);
      file = index.get(key(ref.agentId, ref.sessionId));
    }
    const summary = file ? cache.get(file)?.scan.summary : null;
    if (!summary) throwIpcError('NOT_FOUND', 'session not found');
    return summary;
  }

  return {
    async sessions(opts = {}) {
      const s = await ensureScanned(opts.refresh === true);
      const sessions: SessionSummary[] = [];
      for (const f of s.files) {
        const summary = cache.get(f.file)?.scan.summary;
        if (summary) sessions.push(summary);
      }
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      return { sessions, scannedAt: s.at, truncated: s.truncated };
    },

    async localUsage(opts = {}) {
      const s = await ensureScanned(opts.refresh === true);
      const perFile = s.files.map((f) => cache.get(f.file)?.scan.usage ?? []);
      return aggregateLocalUsage(perFile, { now: s.at, retentionDays: USAGE_RETENTION_DAYS });
    },

    find,

    async transcript(ref) {
      const session = await find(ref);
      const file = index.get(key(ref.agentId, ref.sessionId))!;
      let text: string;
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch {
        throwIpcError('NOT_FOUND', 'session not found');
      }
      const all: TranscriptEntry[] =
        ref.agentId === 'claude' ? claudeTranscript(jsonLines(text)) : codexTranscript(jsonLines(text));
      const truncated = all.length > TRANSCRIPT_ENTRIES_MAX;
      // Keep the most recent entries — the end of a long session is what resuming needs.
      const entries = truncated ? all.slice(all.length - TRANSCRIPT_ENTRIES_MAX) : all;
      return { session, entries, truncated };
    },
  };
}
