// models.dev catalog — enrich provider model lists with display names and flags.
//
// Outbound GET to https://models.dev/api.json (public, no key). Cached in memory with
// a TTL so fetch-models and snapshots do not hammer the CDN. Nothing logged may carry
// a user key; this module never sees one.

import type { ProviderModel } from '../../shared/aiProviders';
import type { FetchLike } from './modelCatalog';

const CATALOG_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CatalogModelMeta {
  name?: string;
  reasoning?: boolean;
  canonical_model_id?: string;
}

type CatalogDoc = Record<string, { models?: Record<string, CatalogModelMeta> }>;

let cachedIndex: Map<string, CatalogModelMeta> | null = null;
let cachedAt = 0;

function normalizeLookupId(id: string): string {
  return id.trim().toLowerCase();
}

function indexCatalog(doc: CatalogDoc): Map<string, CatalogModelMeta> {
  const index = new Map<string, CatalogModelMeta>();
  for (const entry of Object.values(doc)) {
    const models = entry?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [modelId, meta] of Object.entries(models)) {
      if (!meta || typeof meta !== 'object') continue;
      index.set(normalizeLookupId(modelId), meta);
      if (typeof meta.canonical_model_id === 'string' && meta.canonical_model_id !== '') {
        index.set(normalizeLookupId(meta.canonical_model_id), meta);
      }
    }
  }
  return index;
}

async function loadCatalog(fetchImpl: FetchLike): Promise<Map<string, CatalogModelMeta>> {
  const now = Date.now();
  if (cachedIndex && now - cachedAt < CACHE_TTL_MS) return cachedIndex;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let response;
  try {
    response = await fetchImpl(CATALOG_URL, { method: 'GET', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    return cachedIndex ?? new Map();
  }
  let doc: unknown;
  try {
    doc = await response.json();
  } catch {
    return cachedIndex ?? new Map();
  }
  if (!doc || typeof doc !== 'object') return cachedIndex ?? new Map();
  cachedIndex = indexCatalog(doc as CatalogDoc);
  cachedAt = now;
  return cachedIndex;
}

function lookupMeta(index: Map<string, CatalogModelMeta>, modelId: string): CatalogModelMeta | undefined {
  const key = normalizeLookupId(modelId);
  const direct = index.get(key);
  if (direct) return direct;
  const slash = key.lastIndexOf('/');
  if (slash >= 0) {
    const tail = key.slice(slash + 1);
    const byTail = index.get(tail);
    if (byTail) return byTail;
  }
  return undefined;
}

/** Attach catalogName / reasoning when a models.dev entry matches the model id. */
export async function enrichProviderModels(
  models: ProviderModel[],
  fetchImpl: FetchLike,
): Promise<ProviderModel[]> {
  if (models.length === 0) return models;
  let index: Map<string, CatalogModelMeta>;
  try {
    index = await loadCatalog(fetchImpl);
  } catch {
    return models;
  }
  if (index.size === 0) return models;

  return models.map((m) => {
    const meta = lookupMeta(index, m.id);
    if (!meta) return m;
    const catalogName = typeof meta.name === 'string' && meta.name.trim() !== '' ? meta.name.trim() : undefined;
    const reasoning = meta.reasoning === true ? true : undefined;
    if (catalogName === undefined && reasoning === undefined) return m;
    return {
      ...m,
      ...(catalogName !== undefined ? { catalogName } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
  });
}

/** Test helper — reset in-memory cache between unit tests. */
export function resetModelsDevCacheForTests(): void {
  cachedIndex = null;
  cachedAt = 0;
}
