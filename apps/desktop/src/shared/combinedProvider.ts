// Virtual "all providers" pool entry — one model list for every configured provider.

import { API_FORMATS, type ApiFormat, type ProviderModel } from './aiProviders';
import type { ProviderSummary } from './ipc-channels';
import { COMBINED_PROVIDER_ID, encodeCombinedModelKey, formatModelRef } from './modelRef';

export function isCombinedProviderId(id: string): boolean {
  return id === COMBINED_PROVIDER_ID;
}

/** Build the synthetic provider row, or null when the pool is empty. */
export function buildCombinedProviderSummary(
  providers: readonly ProviderSummary[],
  displayName: string,
): ProviderSummary | null {
  const real = providers.filter((p) => !isCombinedProviderId(p.id));
  if (real.length === 0) return null;

  const formats = new Set<ApiFormat>();
  const models: ProviderModel[] = [];

  for (const p of real) {
    for (const f of p.apiFormats) formats.add(f);
    for (const m of p.models) {
      models.push({
        id: encodeCombinedModelKey(p.id, m.id),
        alias: formatModelRef(p.name, m),
        catalogName: m.catalogName,
        reasoning: m.reasoning,
      });
    }
  }

  models.sort((a, b) => (a.alias ?? a.id).localeCompare(b.alias ?? b.id, undefined, { sensitivity: 'base', numeric: true }));

  return {
    id: COMBINED_PROVIDER_ID,
    name: displayName,
    apiFormats: API_FORMATS.filter((f) => formats.has(f)),
    baseUrl: '',
    models,
    createdAt: 0,
    hasKey: real.some((p) => p.hasKey),
    virtual: true,
  };
}
