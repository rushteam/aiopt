// Live routing status — what the routing groups did lately, for the Providers page.
//
// Pure types (no I/O). Everything here is held in main-process memory only and reaches the
// renderer through a read-only IPC snapshot + a push event. It carries identifiers, status
// codes, latencies and times ONLY: never request / reply content, keys, or the raw
// conversation key (affinity shows as a count of pinned sessions).

import type { AgentId } from './aiProviders';
import type { RoutingStrategy } from './routingGroups';

/** Most recent routing decisions kept in memory (oldest dropped). */
export const ROUTING_RECENT_MAX = 100;

/** Window the per-group summary covers (ms). */
export const ROUTING_SUMMARY_WINDOW_MS = 60 * 60 * 1000;

/** One upstream attempt inside a routing decision. */
export interface RoutingAttempt {
  providerId: string;
  /** Canonical member model id (as in the group), not the wire alias. */
  modelId: string;
  /** Upstream HTTP status; 0 = never reached. */
  status: number;
  ok: boolean;
  /** Time this attempt took, ms (a stream counts until it ends). */
  ms: number;
}

/** One request a routing group served (or failed to). */
export interface RoutingDecision {
  /** Monotonic id within this run. */
  id: number;
  at: number;
  groupId: string;
  agentId: AgentId;
  strategy: RoutingStrategy;
  /** The conversation went to the member it was pinned to (session affinity hit). */
  sticky: boolean;
  /** Try order as it happened; the last one is the answer (or the final failure). */
  attempts: RoutingAttempt[];
  ok: boolean;
  /** Total time, ms. */
  ms: number;
}

/** One member's live state. */
export interface RoutingMemberStatus {
  providerId: string;
  modelId: string;
  /** Cooling down until this time (ms epoch); null = ready. Tried last while cooling. */
  coolingUntil: number | null;
  /** Ok replies this run (the least_used count). */
  okCount: number;
  lastOkAt: number | null;
  lastFailAt: number | null;
  /** Status of the most recent failure, when there was one. */
  lastFailStatus: number | null;
  /** For `rotate`: this member starts the next request. */
  next: boolean;
}

export interface RoutingGroupSummaryStats {
  /** Requests in the window. */
  requests: number;
  /** Of those, how many needed more than one attempt. */
  failovers: number;
  /** Answers by member, in member order (same length as the group's members). */
  hits: number[];
}

export interface RoutingGroupStatus {
  groupId: string;
  members: RoutingMemberStatus[];
  /** Conversations currently pinned to a member (count only — never the keys). */
  pinnedSessions: number;
  lastHour: RoutingGroupSummaryStats;
}

export interface RoutingStatusSnapshot {
  /** When the snapshot was taken (main's clock). */
  at: number;
  groups: RoutingGroupStatus[];
  /** Newest first, at most {@link ROUTING_RECENT_MAX}. */
  recent: RoutingDecision[];
}

export const EMPTY_ROUTING_STATUS: RoutingStatusSnapshot = { at: 0, groups: [], recent: [] };

/** Split a candidate seat back into its provider + canonical model id. */
export function splitSeat(seat: string): { providerId: string; modelId: string } {
  const i = seat.indexOf('\u241f');
  if (i < 0) return { providerId: seat, modelId: '' };
  return { providerId: seat.slice(0, i), modelId: seat.slice(i + 1) };
}
