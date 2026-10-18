// Plan the candidate order for one routing-group request.
//
// Pure: takes members + strategy + optional affinity stick + cooldown set +
// usage counts, returns ordered seats. The proxy runs them in order and stops
// at the first answer that is not a failover status (or the last one).

import {
  applyAffinityOrder,
  candidateSeat,
  deferCooling,
  orderMemberIndexes,
  type RoutingAffinity,
  type RoutingCandidate,
  type RoutingGroupMember,
  type RoutingStrategy,
} from '../../../shared/routingGroups';
import type { ApiFormat } from '../../../shared/aiProviders';

export interface ResolvedMember extends RoutingGroupMember {
  outboundFormat: ApiFormat;
  upstreamBaseUrl: string;
  /** Wire model name forced onto the upstream request. */
  wireModelId: string;
}

export interface PlanInput {
  members: readonly ResolvedMember[];
  strategy: RoutingStrategy;
  affinity: RoutingAffinity;
  /** Seat remembered for this conversation, if any. */
  stickySeat: string | null;
  cooling: ReadonlySet<string>;
  /** Ok-request counts by seat (for least_used). */
  usageBySeat: ReadonlyMap<string, number>;
  /** Next rotate start index for this group. */
  rotateCursor: number;
}

export interface PlanResult {
  candidates: RoutingCandidate[];
  /** Indexes into `members` in try order. */
  order: number[];
}

export function planRoutingOrder(input: PlanInput): PlanResult {
  const seats = input.members.map((m) => candidateSeat(m.providerId, m.modelId));
  let order = orderMemberIndexes(input.strategy, input.members.length, {
    rotateCursor: input.rotateCursor,
    usageBySeat: input.usageBySeat,
    seats,
  });

  if (input.affinity === 'session' && input.stickySeat) {
    const stickyIndex = seats.indexOf(input.stickySeat);
    order = applyAffinityOrder(order, stickyIndex >= 0 ? stickyIndex : null);
  }

  order = deferCooling(order, seats, input.cooling);

  const candidates: RoutingCandidate[] = order.map((i) => {
    const m = input.members[i]!;
    return {
      seat: seats[i]!,
      providerId: m.providerId,
      modelId: m.wireModelId,
      outboundFormat: m.outboundFormat,
      upstreamBaseUrl: m.upstreamBaseUrl,
    };
  });

  return { candidates, order };
}
