// Live routing-group state held by the translation proxy: cooldown, rotate cursors,
// affinity sticks, and in-memory least_used counts (ok replies only).

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

export interface RoutingRuntimeDeps {
  getGroup(id: string): RoutingGroup | null;
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
  ): { group: RoutingGroup; candidates: RoutingCandidate[]; conversationKey: string | null } | null;
  onFailover(seat: string): void;
  onSuccess(groupId: string, conversationKey: string | null, seat: string): void;
  clearGroup(groupId: string): void;
  cooldown: CooldownBook;
}

export function createRoutingRuntime(deps: RoutingRuntimeDeps): RoutingRuntime {
  const cooldown = createCooldownBook();
  const rotateCursor = new Map<string, number>();
  /** Ok-reply counts by seat for least_used (process-local; resets on restart). */
  const okBySeat = new Map<string, number>();

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

      return { group, candidates, conversationKey };
    },

    onFailover(seat) {
      cooldown.rest(seat);
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
    },
  };
}
