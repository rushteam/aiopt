// Expand a routing group into concrete upstream members the proxy can try.
//
// Lives beside the proxy (not in shared/) because it needs provider records +
// binding-route resolution. Pure aside from those lookups — no I/O.

import {
  resolveBindingRoute,
  wireModelName,
  type AgentDef,
  type AgentId,
  type ApiFormat,
  type Provider,
} from '../../../shared/aiProviders';
import type { RoutingGroup } from '../../../shared/routingGroups';
import type { ResolvedMember } from './plan';

export interface ExpandLookups {
  getProvider(id: string): Provider | null;
  getAgentDef(id: AgentId): AgentDef | null;
}

/**
 * Resolve each group member to an upstream the agent can reach through the proxy.
 * Members whose provider is gone, or whose formats the proxy cannot carry, are
 * skipped (fail-closed per seat, not for the whole group).
 */
export function expandRoutingGroup(
  group: RoutingGroup,
  agentId: AgentId,
  inboundFormat: ApiFormat,
  lookups: ExpandLookups,
): ResolvedMember[] {
  const def = lookups.getAgentDef(agentId);
  if (!def) return [];

  const out: ResolvedMember[] = [];
  for (const m of group.members) {
    const provider = lookups.getProvider(m.providerId);
    if (!provider) continue;
    const model = provider.models.find((x) => x.id === m.modelId);
    if (!model) continue;
    const route = resolveBindingRoute(def, provider.apiFormats);
    if (!route) continue;
    // The live inbound dialect is fixed by the agent binding; refuse a member that
    // would need a different inbound than the route already registered.
    if (route.inbound !== inboundFormat) continue;
    out.push({
      providerId: provider.id,
      modelId: model.id,
      outboundFormat: route.outbound,
      upstreamBaseUrl: provider.baseUrl,
      wireModelId: wireModelName(model),
    });
  }
  return out;
}
