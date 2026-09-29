// Model catalog — the one place AiOpt makes an OUTBOUND call to a provider's API.
//
// Given a provider's format + base URL + (optional) key, it asks that provider
// for its list of models so the UI can offer them instead of hand-typing ids.
// This is a privileged network capability: it runs only in main, the transport is
// injected (Electron's `net.fetch` in production, a stub in tests), and NOTHING it
// throws or logs may contain the key — errors carry only a generic coded message
// (see credentials-and-local-storage.md).

import type { ApiFormat, ProviderModel } from '../../shared/aiProviders';
import { throwIpcError } from '../ipc/validate';
import {
  enrichProviderModels,
  getModelsDevCacheStatus,
  listModelsFromModelsDevFallback,
  type ModelsDevCatalogSource,
} from './modelsDev';

/** The minimal Response shape we depend on — satisfied by both `fetch` and `net.fetch`. */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** The injected transport. Structurally compatible with `fetch` / Electron `net.fetch`. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchLikeResponse>;

export interface FetchModelsInput {
  /** The formats the provider serves; each distinct catalog endpoint is tried in turn. */
  apiFormats: readonly ApiFormat[];
  baseUrl: string;
  /** Resolved main-side; may be null when the provider has no stored key. */
  apiKey: string | null;
}

/** One catalog call's inputs — a single format, for the per-dialect fetchers below. */
interface CatalogInput {
  baseUrl: string;
  apiKey: string | null;
}

/** Abort a hung request rather than leaving the UI spinning forever. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Strip trailing slashes so we can append a path segment safely. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** Does the base URL already end in a version segment (`/v1`, `/v1beta`, …)? */
function endsWithVersion(base: string): boolean {
  return /\/v\d+(?:[a-z]+\d*)?$/i.test(base);
}

/** GET a JSON body, mapping transport / status failures to safe coded errors (never the key). */
async function fetchJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: FetchLikeResponse;
  try {
    response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
  } catch {
    // Network failure, DNS, TLS, or timeout. Deliberately drops the original error
    // (it can echo the request, which carries the key) for a generic message.
    throwIpcError('UPSTREAM_ERROR', 'could not reach the provider');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throwIpcError('UNAUTHORIZED', 'the provider rejected the API key');
  }
  if (!response.ok) {
    // The numeric status is safe to surface; the body is not (may reflect the key).
    throwIpcError('UPSTREAM_ERROR', `the provider returned status ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throwIpcError('UPSTREAM_ERROR', 'the provider returned an unreadable response');
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Read one catalog entry's id into a ProviderModel, or null if it has no usable id. */
function readModel(entry: unknown, idKey: string, stripPrefix?: string): ProviderModel | null {
  if (!entry || typeof entry !== 'object') return null;
  const obj = entry as Record<string, unknown>;
  let id = typeof obj[idKey] === 'string' ? (obj[idKey] as string) : '';
  if (stripPrefix && id.startsWith(stripPrefix)) id = id.slice(stripPrefix.length);
  id = id.trim();
  if (id === '') return null;
  return { id };
}

/** Collapse duplicate ids, keeping the first occurrence. */
function dedupe(models: (ProviderModel | null)[]): ProviderModel[] {
  const byId = new Map<string, ProviderModel>();
  for (const m of models) {
    if (m && !byId.has(m.id)) byId.set(m.id, m);
  }
  return [...byId.values()];
}

// OpenAI-compatible: GET {base}/models (base usually already ends in /v1), key as
// `Authorization: Bearer`. Response: { data: [{ id }] } — no display name.
async function fetchOpenAiModels(input: CatalogInput, fetchImpl: FetchLike): Promise<ProviderModel[]> {
  const base = normalizeBase(input.baseUrl);
  const url = endsWithVersion(base) ? `${base}/models` : `${base}/v1/models`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`;
  const body = await fetchJson(url, headers, fetchImpl);
  const data = asArray((body as { data?: unknown }).data);
  return dedupe(data.map((e) => readModel(e, 'id')));
}

// Anthropic: GET {base}/v1/models, key as `x-api-key` + `anthropic-version`.
// Response: { data: [{ id, display_name }] } — we take only the id.
async function fetchAnthropicModels(input: CatalogInput, fetchImpl: FetchLike): Promise<ProviderModel[]> {
  const base = normalizeBase(input.baseUrl);
  const url = endsWithVersion(base) ? `${base}/models` : `${base}/v1/models`;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (input.apiKey) headers['x-api-key'] = input.apiKey;
  const body = await fetchJson(url, headers, fetchImpl);
  const data = asArray((body as { data?: unknown }).data);
  return dedupe(data.map((e) => readModel(e, 'id')));
}

// Gemini: GET {base}/v1beta/models?key=<key> (key in the query, not a header).
// Response: { models: [{ name: "models/<id>", displayName }] } — we take only the id.
async function fetchGeminiModels(input: CatalogInput, fetchImpl: FetchLike): Promise<ProviderModel[]> {
  const base = normalizeBase(input.baseUrl);
  const path = endsWithVersion(base) ? `${base}/models` : `${base}/v1beta/models`;
  const url = input.apiKey ? `${path}?key=${encodeURIComponent(input.apiKey)}` : path;
  const body = await fetchJson(url, { accept: 'application/json' }, fetchImpl);
  const models = asArray((body as { models?: unknown }).models);
  return dedupe(models.map((e) => readModel(e, 'name', 'models/')));
}

/**
 * The catalog dialect a format discovers models with. Both OpenAI formats share one:
 * a Responses-native provider (official OpenAI et al.) serves the same `/v1/models` as
 * Chat Completions, so it discovers models identically.
 */
type CatalogKind = 'openai' | 'anthropic' | 'gemini';

function catalogKind(format: ApiFormat): CatalogKind {
  switch (format) {
    case 'openai':
    case 'openai-responses':
      return 'openai';
    case 'anthropic':
      return 'anthropic';
    case 'gemini':
      return 'gemini';
    default:
      throwIpcError('INVALID_PARAMS', 'unsupported api format');
  }
}

const CATALOG_FETCHERS: Record<
  CatalogKind,
  (input: CatalogInput, fetchImpl: FetchLike) => Promise<ProviderModel[]>
> = {
  openai: fetchOpenAiModels,
  anthropic: fetchAnthropicModels,
  gemini: fetchGeminiModels,
};

/**
 * Fetch the model catalog for a provider by its declared formats. `fetchImpl` is
 * injected (main passes Electron's `net.fetch`; tests pass a stub). Each DISTINCT
 * catalog dialect among `apiFormats` is asked in turn (canonical order); the first
 * non-empty list wins. When every dialect fails, the FIRST failure is rethrown — it is
 * the one for the provider's primary format, so its code (UNAUTHORIZED vs UPSTREAM_ERROR)
 * is the most useful. An empty list is returned only when every dialect answered empty.
 * Throws INVALID_PARAMS when `apiFormats` is empty.
 */
export interface FetchProviderModelsOutcome {
  models: ProviderModel[];
  catalogSource: ModelsDevCatalogSource;
  modelsDev: { fetchedAt: number | null; stale: boolean };
}

export async function fetchProviderModelsWithMeta(
  input: FetchModelsInput,
  fetchImpl: FetchLike,
): Promise<FetchProviderModelsOutcome> {
  const kinds = [...new Set(input.apiFormats.map(catalogKind))];
  if (kinds.length === 0) throwIpcError('INVALID_PARAMS', 'at least one apiFormat is required');
  const call: CatalogInput = { baseUrl: input.baseUrl, apiKey: input.apiKey };
  let firstError: unknown;
  let sawEmpty = false;
  for (const kind of kinds) {
    try {
      const models = await CATALOG_FETCHERS[kind](call, fetchImpl);
      if (models.length > 0) {
        const enriched = await enrichProviderModels(models, fetchImpl);
        return {
          models: enriched,
          catalogSource: 'vendor',
          modelsDev: getModelsDevCacheStatus(),
        };
      }
      sawEmpty = true;
    } catch (err) {
      if (firstError === undefined) firstError = err;
    }
  }
  const fallback = await listModelsFromModelsDevFallback(
    { baseUrl: input.baseUrl, apiFormats: input.apiFormats },
    fetchImpl,
  );
  if (fallback.length > 0) {
    const enriched = await enrichProviderModels(fallback, fetchImpl);
    return {
      models: enriched,
      catalogSource: 'models_dev',
      modelsDev: getModelsDevCacheStatus(),
    };
  }
  if (sawEmpty) {
    return { models: [], catalogSource: 'vendor', modelsDev: getModelsDevCacheStatus() };
  }
  throw firstError;
}

export async function fetchProviderModels(
  input: FetchModelsInput,
  fetchImpl: FetchLike,
): Promise<ProviderModel[]> {
  const outcome = await fetchProviderModelsWithMeta(input, fetchImpl);
  return outcome.models;
}
