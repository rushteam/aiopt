// Routing groups — several provider+model members agents bind as one.
//
// Pure types + helpers (no I/O). A group is a virtual pool entry: the agent still
// binds with `{ providerId, modelId }`, but `providerId` is the group's virtual id
// (`__aiopt_rg__` + uuid) and `modelId` is the sentinel {@link ROUTING_GROUP_MODEL_ID}.
// The translation proxy expands the group at request time, orders candidates by
// strategy, optionally sticks a conversation to the last successful member
// (affinity), and fails over to the next before any reply bytes reach the agent.

import type { ApiFormat } from './aiProviders';

/** Virtual pool id prefix — never a real provider UUID / official-* slug. */
export const ROUTING_GROUP_ID_PREFIX = '__aiopt_rg__';

/** Sentinel model id written into an agent binding that points at a routing group. */
export const ROUTING_GROUP_MODEL_ID = '__route__';

/** How candidates are ordered for the next request (before affinity / cooldown). */
export type RoutingStrategy = 'ordered' | 'rotate' | 'least_used';

/** How long a conversation stays on the member that last answered it. */
export type RoutingAffinity = 'off' | 'session';

export const ROUTING_STRATEGIES: readonly RoutingStrategy[] = ['ordered', 'rotate', 'least_used'];
export const ROUTING_AFFINITIES: readonly RoutingAffinity[] = ['off', 'session'];

export interface RoutingGroupMember {
  providerId: string;
  /** Canonical model id on that provider (not the wire alias). */
  modelId: string;
}

export interface RoutingGroup {
  id: string;
  name: string;
  members: RoutingGroupMember[];
  strategy: RoutingStrategy;
  affinity: RoutingAffinity;
  createdAt: number;
}

/** Renderer-safe summary (no secrets). */
export interface RoutingGroupSummary {
  id: string;
  name: string;
  members: RoutingGroupMember[];
  strategy: RoutingStrategy;
  affinity: RoutingAffinity;
  createdAt: number;
  /** Virtual provider id used in bindings (`prefix` + `id`). */
  virtualProviderId: string;
}

export function routingGroupVirtualId(groupId: string): string {
  return `${ROUTING_GROUP_ID_PREFIX}${groupId}`;
}

export function isRoutingGroupProviderId(id: string): boolean {
  return id.startsWith(ROUTING_GROUP_ID_PREFIX) && id.length > ROUTING_GROUP_ID_PREFIX.length;
}

export function routingGroupIdFromVirtual(providerId: string): string | null {
  if (!isRoutingGroupProviderId(providerId)) return null;
  return providerId.slice(ROUTING_GROUP_ID_PREFIX.length);
}

export function isRoutingGroupModelId(modelId: string): boolean {
  return modelId === ROUTING_GROUP_MODEL_ID;
}

/** One concrete upstream attempt after a group (or a plain binding) is resolved. */
export interface RoutingCandidate {
  /** Stable id for affinity / cooldown (`providerId` + sep + `modelId`). */
  seat: string;
  providerId: string;
  modelId: string;
  outboundFormat: ApiFormat;
  upstreamBaseUrl: string;
}

export function candidateSeat(providerId: string, modelId: string): string {
  return `${providerId}\u241f${modelId}`;
}

/** Upstream statuses that mean "try the next member" (before any client bytes). */
export const ROUTING_FAILOVER_STATUS: ReadonlySet<number> = new Set([
  0, // transport failure / never reached
  401, // another member may hold a working key
  403,
  408,
  429,
  500,
  502,
  503,
  504,
  529,
]);

export function shouldFailoverStatus(status: number): boolean {
  return ROUTING_FAILOVER_STATUS.has(status);
}

/**
 * Order member indexes for a request. `rotateCursor` is the group's next start
 * index (caller increments after a successful answer for `rotate`). `usageBySeat`
 * counts prior ok requests for `least_used` (missing = 0).
 */
export function orderMemberIndexes(
  strategy: RoutingStrategy,
  memberCount: number,
  opts: { rotateCursor?: number; usageBySeat?: ReadonlyMap<string, number>; seats?: readonly string[] } = {},
): number[] {
  if (memberCount <= 0) return [];
  const identity = Array.from({ length: memberCount }, (_, i) => i);
  switch (strategy) {
    case 'ordered':
      return identity;
    case 'rotate': {
      const start = ((opts.rotateCursor ?? 0) % memberCount + memberCount) % memberCount;
      return identity.map((i) => (i + start) % memberCount);
    }
    case 'least_used': {
      const seats = opts.seats;
      const usage = opts.usageBySeat;
      if (!seats || seats.length !== memberCount || !usage) return identity;
      return identity
        .map((i) => i)
        .sort((a, b) => {
          const ua = usage.get(seats[a]!) ?? 0;
          const ub = usage.get(seats[b]!) ?? 0;
          if (ua !== ub) return ua - ub;
          return a - b;
        });
    }
    default:
      return identity;
  }
}

/**
 * Put a sticky seat first when it is still among the ordered candidates; otherwise
 * leave the order alone (affinity miss / cold / off).
 */
export function applyAffinityOrder(order: readonly number[], stickyIndex: number | null): number[] {
  if (stickyIndex === null || stickyIndex < 0) return [...order];
  const i = order.indexOf(stickyIndex);
  if (i <= 0) return [...order];
  const next = [...order];
  next.splice(i, 1);
  next.unshift(stickyIndex);
  return next;
}

/**
 * Move seats currently cooling down after a failover to the back, preserving relative order.
 */
export function deferCooling(
  order: readonly number[],
  seats: readonly string[],
  cooling: ReadonlySet<string>,
): number[] {
  const ready: number[] = [];
  const deferred: number[] = [];
  for (const i of order) {
    const seat = seats[i];
    if (seat && cooling.has(seat)) deferred.push(i);
    else ready.push(i);
  }
  return ready.length > 0 ? [...ready, ...deferred] : [...deferred];
}

/** Cap on remembered conversation sticks (oldest dropped). */
export const ROUTING_AFFINITY_MAX = 512;

/** How long a stick is kept without a successful reply (ms). */
export const ROUTING_AFFINITY_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a seat rests after a failover-eligible failure (ms). */
export const ROUTING_COOLDOWN_MS = 60_000;

/**
 * Best-effort conversation key from inbound headers + JSON body. Returns null when
 * nothing trustworthy is present — affinity then does not stick.
 *
 * Never logs the value; callers must treat it as opaque identifier only.
 */
export function extractConversationKey(
  headers: { get(name: string): string | null | undefined },
  body: Record<string, unknown> | null,
): string | null {
  const headerNames = [
    'session_id',
    'session-id',
    'x-session-id',
    'conversation_id',
    'conversation-id',
    'x-conversation-id',
    'thread_id',
    'thread-id',
  ];
  for (const name of headerNames) {
    const v = headers.get(name) ?? headers.get(name.toUpperCase());
    const cleaned = cleanKey(v);
    if (cleaned) return cleaned;
  }

  if (!body) return null;

  const direct = cleanKey(asString(body.session_id) ?? asString(body.conversation_id) ?? asString(body.thread_id));
  if (direct) return direct;

  const meta = body.metadata;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const m = meta as Record<string, unknown>;
    const fromMeta = cleanKey(
      asString(m.session_id) ?? asString(m.conversation_id) ?? asString(m.thread_id),
    );
    if (fromMeta) return fromMeta;
    // Anthropic / Claude Code sometimes nest session_id inside user_id JSON.
    const userId = asString(m.user_id);
    if (userId && userId.startsWith('{')) {
      try {
        const parsed = JSON.parse(userId) as Record<string, unknown>;
        const nested = cleanKey(asString(parsed.session_id));
        if (nested) return nested;
      } catch {
        // ignore
      }
    }
  }

  const cacheKey = cleanKey(asString(body.prompt_cache_key));
  if (cacheKey) return `pck:${cacheKey}`;

  return null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function cleanKey(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (t.length < 1 || t.length > 128) return null;
  if (/[\r\n\t]/.test(t)) return null;
  return t;
}
