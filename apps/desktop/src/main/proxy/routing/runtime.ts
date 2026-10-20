// Live routing-group state held by the translation proxy: cooldown, rotate cursors,
// affinity sticks, in-memory least_used counts (ok replies only), and the recent
// decisions the Providers page shows. All of it lives in main-process memory only and
// carries ids / status codes / times — never content, keys, or conversation keys.

import type { AgentId, ApiFormat } from '../../../shared/aiProviders';
import {
  candidateSeat,
  extractConversationKey,
  type RoutingCandidate,
  type RoutingGroup,
} from '../../../shared/routingGroups';
import { createCooldownBook, type CooldownBook } from './cooldown';
import { expandRoutingGroup, type ExpandLookups } from './expand';
import { planRoutingOrder, type ResolvedMember } from './plan';
import type { SessionAffinityStore } from './sessionAffinity';
import {
  ROUTING_RECENT_MAX,
  ROUTING_SUMMARY_WINDOW_MS,
  splitSeat,
  type RoutingAttempt,
  type RoutingDecision,
  type RoutingGroupStatus,
  type RoutingStatusSnapshot,
} from '../../../shared/routingStatus';

/** Per-group cap on the decisions kept for the last-hour summary (oldest dropped). */
const SUMMARY_KEEP_MAX = 5000;

/** What the proxy reports after a routing-group request finishes. */
export type RoutingDecisionInput = Omit<RoutingDecision, 'id' | 'at'>;

export interface RoutingRuntimeDeps {
  getGroup(id: string): RoutingGroup | null;
  /** Every group, for the status snapshot. */
  listGroups?(): RoutingGroup[];
  lookups: ExpandLookups;
  affinity: SessionAffinityStore;
}

export interface RoutingRuntime {
  plan(
    groupId: string,
    agentId: AgentId,
    inboundFormat: ApiFormat,
    headers: { get(name: string): string | null | undefined },
    body: Record<string, unknown>,
  ): {
    group: RoutingGroup;
    candidates: RoutingCandidate[];
    conversationKey: string | null;
    /** The first candidate is the seat this conversation was pinned to. */
    sticky?: boolean;
  } | null;
  onFailover(seat: string): void;
  onSuccess(groupId: string, conversationKey: string | null, seat: string): void;
  clearGroup(groupId: string): void;
  cooldown: CooldownBook;
  /** Record one finished routing-group request (ids, statuses, times only). */
  recordDecision?(input: RoutingDecisionInput, now?: number): void;
  /** Live per-group state + recent decisions, for the Providers page. */
  status?(now?: number): RoutingStatusSnapshot;
  /**
   * End a member's cooldown now (the user's "retry now"). In-memory only; false when the
   * group / member is unknown or it was not cooling.
   */
  retryNow?(groupId: string, providerId: string, modelId: string): boolean;
  /** Called after any change the status snapshot would show. Returns an unsubscribe. */
  onStatusChange?(listener: () => void): () => void;
}

export function createRoutingRuntime(deps: RoutingRuntimeDeps): RoutingRuntime {
  const cooldown = createCooldownBook();
  const rotateCursor = new Map<string, number>();
  /** Ok-reply counts by seat for least_used (process-local; resets on restart). */
  const okBySeat = new Map<string, number>();
  /** Last ok / failure per seat (times + status only). */
  const seatSeen = new Map<string, { lastOkAt: number | null; lastFailAt: number | null; lastFailStatus: number | null }>();
  /** Newest first. */
  let recent: RoutingDecision[] = [];
  /** Per group: oldest first, pruned to the summary window. */
  const summaryLog = new Map<string, { at: number; failover: boolean; answeredBy: string | null }[]>();
  let nextDecisionId = 1;
  const listeners = new Set<() => void>();

  function changed(): void {
    for (const l of listeners) {
      try {
        l();
      } catch {
        // a listener must not break routing
      }
    }
  }

  function pruneSummary(groupId: string, now: number): { at: number; failover: boolean; answeredBy: string | null }[] {
    const cutoff = now - ROUTING_SUMMARY_WINDOW_MS;
    const log = (summaryLog.get(groupId) ?? []).filter((e) => e.at >= cutoff);
    if (log.length > SUMMARY_KEEP_MAX) log.splice(0, log.length - SUMMARY_KEEP_MAX);
    if (log.length === 0) summaryLog.delete(groupId);
    else summaryLog.set(groupId, log);
    return log;
  }

  function seen(seat: string) {
    let s = seatSeen.get(seat);
    if (!s) {
      s = { lastOkAt: null, lastFailAt: null, lastFailStatus: null };
      seatSeen.set(seat, s);
    }
    return s;
  }

  return {
    cooldown,

    plan(groupId, agentId, inboundFormat, headers, body) {
      const group = deps.getGroup(groupId);
      if (!group) return null;
      const members: ResolvedMember[] = expandRoutingGroup(group, agentId, inboundFormat, deps.lookups);
      if (members.length === 0) return null;

      const conversationKey = extractConversationKey(headers, body);
      const stickySeat =
        group.affinity === 'session' && conversationKey
          ? deps.affinity.get(groupId, conversationKey)
          : null;

      const seats = members.map((m) => candidateSeat(m.providerId, m.modelId));
      const usageBySeat = new Map<string, number>();
      if (group.strategy === 'least_used') {
        for (const seat of seats) usageBySeat.set(seat, okBySeat.get(seat) ?? 0);
      }

      const { candidates } = planRoutingOrder({
        members,
        strategy: group.strategy,
        affinity: group.affinity,
        stickySeat,
        cooling: cooldown.restingSeats(),
        usageBySeat,
        rotateCursor: rotateCursor.get(groupId) ?? 0,
      });

      const sticky = stickySeat !== null && candidates[0]?.seat === stickySeat;
      return { group, candidates, conversationKey, sticky };
    },

    onFailover(seat) {
      cooldown.rest(seat);
      changed();
    },

    onSuccess(groupId, conversationKey, seat) {
      okBySeat.set(seat, (okBySeat.get(seat) ?? 0) + 1);
      const group = deps.getGroup(groupId);
      if (group?.strategy === 'rotate') {
        const n = group.members.length;
        if (n > 0) rotateCursor.set(groupId, ((rotateCursor.get(groupId) ?? 0) + 1) % n);
      }
      if (group?.affinity === 'session' && conversationKey) {
        deps.affinity.remember(groupId, conversationKey, seat);
      }
    },

    clearGroup(groupId) {
      rotateCursor.delete(groupId);
      deps.affinity.clearGroup(groupId);
      summaryLog.delete(groupId);
      recent = recent.filter((d) => d.groupId !== groupId);
      changed();
    },

    recordDecision(input, now = Date.now()) {
      // Copy field by field: only the declared, content-free fields are kept.
      const attempts: RoutingAttempt[] = input.attempts.map((a) => ({
        providerId: a.providerId,
        modelId: a.modelId,
        status: a.status,
        ok: a.ok,
        ms: Math.max(0, Math.round(a.ms)),
      }));
      const decision: RoutingDecision = {
        id: nextDecisionId++,
        at: now,
        groupId: input.groupId,
        agentId: input.agentId,
        strategy: input.strategy,
        sticky: input.sticky,
        attempts,
        ok: input.ok,
        ms: Math.max(0, Math.round(input.ms)),
      };
      recent.unshift(decision);
      if (recent.length > ROUTING_RECENT_MAX) recent.length = ROUTING_RECENT_MAX;

      for (const a of attempts) {
        const s = seen(candidateSeat(a.providerId, a.modelId));
        if (a.ok) s.lastOkAt = now;
        else {
          s.lastFailAt = now;
          s.lastFailStatus = a.status;
        }
      }
      const last = attempts[attempts.length - 1];
      const log = pruneSummary(input.groupId, now);
      log.push({
        at: now,
        failover: attempts.length > 1,
        answeredBy: input.ok && last ? candidateSeat(last.providerId, last.modelId) : null,
      });
      summaryLog.set(input.groupId, log);
      changed();
    },

    status(now = Date.now()) {
      const groups: RoutingGroupStatus[] = (deps.listGroups?.() ?? []).map((group) => {
        const seats = group.members.map((m) => candidateSeat(m.providerId, m.modelId));
        const n = seats.length;
        const cursor = n > 0 ? (((rotateCursor.get(group.id) ?? 0) % n) + n) % n : 0;
        const log = pruneSummary(group.id, now);
        const hits = seats.map((seat) => log.filter((e) => e.answeredBy === seat).length);
        return {
          groupId: group.id,
          members: seats.map((seat, i) => {
            const { providerId, modelId } = splitSeat(seat);
            const s = seatSeen.get(seat);
            return {
              providerId,
              modelId,
              coolingUntil: cooldown.restingUntil(seat, now),
              okCount: okBySeat.get(seat) ?? 0,
              lastOkAt: s?.lastOkAt ?? null,
              lastFailAt: s?.lastFailAt ?? null,
              lastFailStatus: s?.lastFailStatus ?? null,
              next: group.strategy === 'rotate' && n > 1 && i === cursor,
            };
          }),
          pinnedSessions: group.affinity === 'session' ? deps.affinity.countGroup(group.id, now) : 0,
          lastHour: {
            requests: log.length,
            failovers: log.filter((e) => e.failover).length,
            hits,
          },
        };
      });
      return { at: now, groups, recent: recent.map((d) => ({ ...d, attempts: d.attempts.map((a) => ({ ...a })) })) };
    },

    retryNow(groupId, providerId, modelId) {
      const group = deps.getGroup(groupId);
      if (!group) return false;
      if (!group.members.some((m) => m.providerId === providerId && m.modelId === modelId)) return false;
      const lifted = cooldown.lift(candidateSeat(providerId, modelId));
      if (lifted) changed();
      return lifted;
    },

    onStatusChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
