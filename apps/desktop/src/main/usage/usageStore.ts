// Usage store — the main-process sink for proxy-recorded usage events.
//
// Same discipline as providerStore.ts: persistence is injected (Electron-free, unit
// testable) and every persisted line is validated one-by-one with corrupt entries
// DROPPED (fail-closed) so a hand-mangled log can never wedge startup. Events hold only
// counts + identifiers (see shared/usageStats.ts) — no content, keys, or token plaintext.
//
// On disk the log is JSONL (one event per line): appends are O(1), and the store
// compacts (atomic rewrite) when it prunes expired/corrupt lines or crosses a size
// threshold, so the file cannot grow without bound.

import fs from 'node:fs';
import path from 'node:path';
import { renameSyncWithRetry } from '../fsRetry';
import { API_FORMATS, type ApiFormat } from '../../shared/aiProviders';
import {
  aggregateUsage,
  USAGE_RETENTION_DAYS,
  type UsageEvent,
  type UsageEventInput,
  type UsageSnapshot,
} from '../../shared/usageStats';

/** Persistence of the event log. Production writes JSONL; tests inject memory. */
export interface UsagePersistence {
  /** All persisted lines, raw (any shape); the store validates each. */
  load(): unknown[];
  /** Append one already-stamped event. */
  append(event: UsageEvent): void;
  /** Atomically replace the whole log (used on prune/compaction). */
  rewrite(events: UsageEvent[]): void;
}

export interface UsageStore {
  /** Record one upstream attempt; the store stamps `ts` and persists it. */
  record(event: UsageEventInput): void;
  snapshot(): UsageSnapshot;
  clear(): void;
  /** Subscribe to change; returns an unsubscribe thunk. */
  onChange(listener: () => void): () => void;
}

/** Compact the log once it grows past this many lines (keeps appends cheap, file bounded). */
const COMPACT_THRESHOLD = 5000;

// --- validation of untrusted persisted values -----------------------------

function validEvent(raw: unknown): UsageEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Number.isFinite(o.ts)) return null;
  if (typeof o.agentId !== 'string' || o.agentId === '') return null;
  if (typeof o.providerId !== 'string' || o.providerId === '') return null;
  if (typeof o.model !== 'string') return null;
  if (!API_FORMATS.includes(o.inboundFormat as ApiFormat)) return null;
  if (!API_FORMATS.includes(o.outboundFormat as ApiFormat)) return null;
  const num = (v: unknown): number => (Number.isFinite(v) ? (v as number) : 0);
  return {
    ts: o.ts as number,
    agentId: o.agentId,
    providerId: o.providerId,
    model: o.model,
    inboundFormat: o.inboundFormat as ApiFormat,
    outboundFormat: o.outboundFormat as ApiFormat,
    streamed: o.streamed === true,
    ok: o.ok === true,
    status: num(o.status),
    inputTokens: num(o.inputTokens),
    outputTokens: num(o.outputTokens),
  };
}

/** Keep only finite, in-window events (cutoff by retention before `now`). */
function prune(events: UsageEvent[], now: number, retentionDays: number): UsageEvent[] {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return events.filter((e) => e.ts >= cutoff);
}

export function createUsageStore(
  persistence: UsagePersistence,
  opts: { now?: () => number; retentionDays?: number } = {},
): UsageStore {
  const nowFn = opts.now ?? (() => Date.now());
  const retentionDays = opts.retentionDays ?? USAGE_RETENTION_DAYS;

  // Load + validate + prune once. If anything was dropped, compact the file so the
  // corrupt/expired lines don't linger.
  const rawLines = persistence.load();
  const loaded = rawLines.map(validEvent).filter((e): e is UsageEvent => e !== null);
  let events = prune(loaded, nowFn(), retentionDays);
  if (events.length !== rawLines.length) persistence.rewrite(events);

  const listeners = new Set<() => void>();
  function notify(): void {
    for (const listener of listeners) listener();
  }

  return {
    record(input) {
      const event: UsageEvent = { ...input, ts: nowFn() };
      events.push(event);
      persistence.append(event);
      // Periodically compact: prune the expired tail and rewrite in one pass.
      if (events.length > COMPACT_THRESHOLD) {
        const pruned = prune(events, nowFn(), retentionDays);
        if (pruned.length !== events.length) {
          events = pruned;
          persistence.rewrite(events);
        }
      }
      notify();
    },

    snapshot() {
      return aggregateUsage(events, { now: nowFn(), retentionDays });
    },

    clear() {
      events = [];
      persistence.rewrite(events);
      notify();
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * File-backed JSONL persistence. Node-only (no Electron), so it tests against a tmp dir;
 * production points it at `userData/usage-history.jsonl` (see main/paths.ts). Appends are
 * a single line write; `rewrite` is atomic (temp+rename); a missing/corrupt file loads as
 * an empty log rather than throwing, and unparseable lines are skipped.
 */
export function createFileUsagePersistence(filePath: string): UsagePersistence {
  function ensureDir(): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  return {
    load() {
      let text: string;
      try {
        text = fs.readFileSync(filePath, 'utf8');
      } catch {
        return [];
      }
      const out: unknown[] = [];
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // Skip a corrupt line; the store also fail-closes on shape.
        }
      }
      return out;
    },
    append(event) {
      ensureDir();
      fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
    },
    rewrite(events) {
      ensureDir();
      const tmp = `${filePath}.tmp`;
      const contents = events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
      try {
        fs.writeFileSync(tmp, contents, 'utf8');
        renameSyncWithRetry(tmp, filePath);
      } catch (err) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // Best-effort cleanup; preserve the original write error.
        }
        throw err;
      }
    },
  };
}
