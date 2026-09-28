// Which model the workbench agents use: the one pi is bound to on the Providers screen.
//
// The workbench does not add a model picker of its own. It follows pi's binding exactly as
// pi's own config does (piAdapter.ts): through the loopback proxy when that binding is
// routed, straight to the provider otherwise. The credential this returns is secret-class
// (see ResolvedWorkbenchModel.key) — the manager hands it to child processes by environment.

import { getAgentDef, resolveBindingRoute, wireModelName, type ApiFormat } from '../../shared/aiProviders';
import type { ProvidersSnapshot } from '../../shared/ipc-channels';
import { API_BY_FORMAT } from '../providers/adapters/piAdapter';
import type { ResolvedWorkbenchModel } from './workbenchManager';

export interface ModelSources {
  snapshot(): ProvidersSnapshot;
  endpointFor(agentId: 'pi'): { baseUrl: string; token: string; modelId: string; inboundFormat: ApiFormat } | null;
  resolveUpstreamKey(providerId: string): string | null;
}

export function resolveWorkbenchModel(sources: ModelSources): ResolvedWorkbenchModel | null {
  const snap = sources.snapshot();
  const agent = snap.agents.find((a) => a.id === 'pi');
  const binding = agent?.binding;
  if (!binding) return null;
  const provider = snap.providers.find((p) => p.id === binding.providerId);
  if (!provider) return null;
  const model = provider.models.find((m) => m.id === binding.modelId);
  const wire = model ? wireModelName(model) : binding.modelId;

  if (agent.proxied) {
    const endpoint = sources.endpointFor('pi');
    if (!endpoint) return null;
    return {
      view: { providerName: provider.name, modelId: wire, proxied: true },
      baseUrl: endpoint.baseUrl,
      api: API_BY_FORMAT[endpoint.inboundFormat],
      modelId: endpoint.modelId,
      key: endpoint.token,
    };
  }
  // Direct bindings speak a format both sides share. The same route the provider
  // binding uses, so a multi-format provider does not pick a dialect pi cannot.
  const route = resolveBindingRoute(getAgentDef('pi')!, provider.apiFormats);
  if (!route || route.kind !== 'native') return null;
  return {
    view: { providerName: provider.name, modelId: wire, proxied: false },
    baseUrl: provider.baseUrl,
    api: API_BY_FORMAT[route.outbound],
    modelId: wire,
    // A keyless provider (a local server) still needs a non-empty value for pi.
    key: sources.resolveUpstreamKey(provider.id) ?? '',
  };
}
