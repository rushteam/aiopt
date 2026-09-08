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

/** The minimal Response shape we depend on — satisfied by both `fetch` and `net.fetch`. */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** The injected transport. Structurally compatible with `fetch` / Electron `net.fetch`. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchLikeResponse>;

export interface FetchModelsInput {
  apiFormat: ApiFormat;
  baseUrl: string;
  /** Resolved main-side; may be null when the provider has no stored key. */
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
async function fetchOpenAiModels(input: FetchModelsInput, fetchImpl: FetchLike): Promise<ProviderModel[]> {
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
async function fetchAnthropicModels(input: FetchModelsInput, fetchImpl: FetchLike): Promise<ProviderModel[]> {
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
async function fetchGeminiModels(input: FetchModelsInput, fetchImpl: FetchLike): Promise<ProviderModel[]> {
  const base = normalizeBase(input.baseUrl);
  const path = endsWithVersion(base) ? `${base}/models` : `${base}/v1beta/models`;
  const url = input.apiKey ? `${path}?key=${encodeURIComponent(input.apiKey)}` : path;
  const body = await fetchJson(url, { accept: 'application/json' }, fetchImpl);
  const models = asArray((body as { models?: unknown }).models);
  return dedupe(models.map((e) => readModel(e, 'name', 'models/')));
}

/**
 * Fetch the model catalog for a provider by its declared format. `fetchImpl` is
 * injected (main passes Electron's `net.fetch`; tests pass a stub). Returns the
 * models (possibly empty); throws a coded, key-free error on failure.
 */
export function fetchProviderModels(
  input: FetchModelsInput,
  fetchImpl: FetchLike,
): Promise<ProviderModel[]> {
  switch (input.apiFormat) {
    case 'openai':
    // A Responses-native provider (official OpenAI et al.) serves the same
    // `/v1/models` catalog as Chat Completions, so it discovers models identically.
    case 'openai-responses':
      return fetchOpenAiModels(input, fetchImpl);
    case 'anthropic':
      return fetchAnthropicModels(input, fetchImpl);
    case 'gemini':
      return fetchGeminiModels(input, fetchImpl);
    default:
      throwIpcError('INVALID_PARAMS', 'unsupported api format');
  }
}
