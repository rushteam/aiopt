// In-memory (+ optional disk) conversation sticks for routing groups.
//
// A stick remembers which seat last answered a conversation so the next request
// of the same conversation prefers that seat (prompt-cache warmth). Fail-closed
// validation on load; oldest / expired sticks drop first (see ROUTING_AFFINITY_*).

import fs from 'node:fs';
import path from 'node:path';
import { renameSyncWithRetry } from '../../fsRetry';
import { readUtf8WithoutBom } from '../../storeFile';
import {
  ROUTING_AFFINITY_MAX,
  ROUTING_AFFINITY_TTL_MS,
} from '../../../shared/routingGroups';

export interface AffinityStick {
  conversationKey: string;
  groupId: string;
  seat: string;
  at: number;
}

export interface AffinityPersistence {
  load(): unknown;
  save(sticks: AffinityStick[]): void;
}

export interface SessionAffinityStore {
  get(groupId: string, conversationKey: string, now?: number): string | null;
  remember(groupId: string, conversationKey: string, seat: string, now?: number): void;
  clearGroup(groupId: string): void;
  /** How many live sticks a group holds (a count only — never the keys). */
  countGroup(groupId: string, now?: number): number;
}

function validStick(raw: unknown): AffinityStick | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.conversationKey !== 'string' || o.conversationKey.trim() === '') return null;
  if (typeof o.groupId !== 'string' || o.groupId.trim() === '') return null;
  if (typeof o.seat !== 'string' || o.seat.trim() === '') return null;
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
  return {
    conversationKey: o.conversationKey,
    groupId: o.groupId,
    seat: o.seat,
    at: o.at,
  };
}

function prune(sticks: AffinityStick[], now: number): AffinityStick[] {
  const cutoff = now - ROUTING_AFFINITY_TTL_MS;
  const kept = sticks.filter((s) => s.at >= cutoff);
  kept.sort((a, b) => b.at - a.at);
  return kept.slice(0, ROUTING_AFFINITY_MAX);
}

export function createSessionAffinityStore(persistence?: AffinityPersistence): SessionAffinityStore {
  let sticks: AffinityStick[] = [];
  if (persistence) {
    const raw = persistence.load();
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { sticks?: unknown }).sticks)
        ? ((raw as { sticks: unknown[] }).sticks)
        : [];
    sticks = prune(
      list.map(validStick).filter((s): s is AffinityStick => s !== null),
      Date.now(),
    );
  }

  function persist(): void {
    persistence?.save(sticks);
  }

  return {
    get(groupId, conversationKey, now = Date.now()) {
      sticks = prune(sticks, now);
      const hit = sticks.find((s) => s.groupId === groupId && s.conversationKey === conversationKey);
      return hit?.seat ?? null;
    },

    remember(groupId, conversationKey, seat, now = Date.now()) {
      const next = sticks.filter(
        (s) => !(s.groupId === groupId && s.conversationKey === conversationKey),
      );
      next.unshift({ conversationKey, groupId, seat, at: now });
      sticks = prune(next, now);
      persist();
    },

    countGroup(groupId, now = Date.now()) {
      const cutoff = now - ROUTING_AFFINITY_TTL_MS;
      let n = 0;
      for (const s of sticks) if (s.groupId === groupId && s.at >= cutoff) n += 1;
      return n;
    },

    clearGroup(groupId) {
      const before = sticks.length;
      sticks = sticks.filter((s) => s.groupId !== groupId);
      if (sticks.length !== before) persist();
    },
  };
}

export function createFileAffinityPersistence(filePath: string): AffinityPersistence {
  return {
    load() {
      try {
        return JSON.parse(readUtf8WithoutBom(filePath)) as unknown;
      } catch {
        return {};
      }
    },
    save(sticks) {
      const tmp = `${filePath}.tmp`;
      const contents = `${JSON.stringify({ version: 1, sticks }, null, 2)}\n`;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      try {
        fs.writeFileSync(tmp, contents, 'utf8');
        renameSyncWithRetry(tmp, filePath);
      } catch (err) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // best-effort
        }
        throw err;
      }
    },
  };
}
