// models.dev catalog — enrich provider model lists with display names and flags.
//
// Outbound GET to https://models.dev/api.json (public, no key). Cached in memory with
// a TTL so fetch-models and snapshots do not hammer the CDN. Nothing logged may carry
// a user key; this module never sees one.

import type { ApiFormat, ProviderModel } from '../../shared/aiProviders';
import type { FetchLike } from './modelCatalog';

const CATALOG_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export type ModelsDevCatalogSource = 'vendor' | 'models_dev';

export interface ModelsDevCacheStatus {
  fetchedAt: number | null;
  stale: boolean;
}

interface CatalogModelMeta {
  name?: string;
  reasoning?: boolean;
  canonical_model_id?: string;
}

type CatalogDoc = Record<string, { models?: Record<string, CatalogModelMeta> }>;

let cachedIndex: Map<string, CatalogModelMeta> | null = null;
let cachedDoc: CatalogDoc | null = null;
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

export function getModelsDevCacheStatus(): ModelsDevCacheStatus {
  if (cachedAt === 0) return { fetchedAt: null, stale: true };
  return { fetchedAt: cachedAt, stale: Date.now() - cachedAt >= CACHE_TTL_MS };
}

/** Force-refresh the models.dev index (used by the provider form "Refresh catalog"). */
export async function refreshModelsDevCatalog(fetchImpl: FetchLike): Promise<ModelsDevCacheStatus> {
  cachedIndex = null;
  cachedAt = 0;
  await loadCatalog(fetchImpl, true);
  return getModelsDevCacheStatus();
}

async function loadCatalog(fetchImpl: FetchLike, force = false): Promise<Map<string, CatalogModelMeta>> {
  const now = Date.now();
  if (!force && cachedIndex && now - cachedAt < CACHE_TTL_MS) return cachedIndex;

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
  cachedDoc = doc as CatalogDoc;
  cachedIndex = indexCatalog(cachedDoc);
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

const HOST_TO_CATALOG_KEY: [RegExp, string][] = [
  [/anthropic/i, 'anthropic'],
  [/openai/i, 'openai'],
  [/deepseek/i, 'deepseek'],
  [/google/i, 'google'],
  [/gemini/i, 'google'],
  [/mistral/i, 'mistral'],
  [/groq/i, 'groq'],
  [/x\.ai/i, 'xai'],
  [/openrouter/i, 'openrouter'],
  [/siliconflow/i, 'siliconflow'],
  [/githubcopilot|copilot/i, 'github-copilot'],
];

function catalogKeysForBaseUrl(baseUrl: string): string[] {
  const keys = new Set<string>();
  try {
    const host = new URL(baseUrl.trim()).hostname;
    for (const [re, key] of HOST_TO_CATALOG_KEY) {
      if (re.test(host)) keys.add(key);
    }
  } catch {
    // ignore bad URL
  }
  if (keys.size === 0) keys.add('openai');
  return [...keys];
}

/** Model ids from models.dev when the vendor exposes no /models list. */
export async function listModelsFromModelsDevFallback(
  input: { baseUrl: string; apiFormats: readonly ApiFormat[] },
  fetchImpl: FetchLike,
): Promise<ProviderModel[]> {
  void input.apiFormats;
  await loadCatalog(fetchImpl);
  if (!cachedDoc) return [];
  const wanted = catalogKeysForBaseUrl(input.baseUrl);
  const ids: string[] = [];
  for (const key of Object.keys(cachedDoc)) {
    const norm = normalizeLookupId(key);
    if (!wanted.some((w) => norm.includes(normalizeLookupId(w)) || normalizeLookupId(w).includes(norm))) {
      continue;
    }
    const models = cachedDoc[key]?.models;
    if (!models) continue;
    for (const modelId of Object.keys(models)) {
      if (modelId.trim() !== '') ids.push(modelId);
    }
  }
  if (ids.length === 0) {
    for (const entry of Object.values(cachedDoc)) {
      const models = entry?.models;
      if (!models) continue;
      for (const modelId of Object.keys(models)) ids.push(modelId);
      if (ids.length >= 80) break;
    }
  }
  return [...new Set(ids)].slice(0, 120).map((id) => ({ id }));
}

/** Test helper — reset in-memory cache between unit tests. */
export function resetModelsDevCacheForTests(): void {
  cachedIndex = null;
  cachedDoc = null;
  cachedAt = 0;
}
