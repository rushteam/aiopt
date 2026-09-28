// Provider connectivity test — reach the provider with the stored key.
//
// Gateways (LiteLLM, OpenRouter, …) often answer GET /models fine while a tiny
// chat completion returns 500 for routing quirks. So we probe the SAME catalog GET
// as "Load models" first; only if that fails do we POST a minimal completion, trying
// a few configured model ids. Keys stay in headers only; errors never echo the key.

import type { ApiFormat, Provider } from '../../shared/aiProviders';
import { wireModelName } from '../../shared/aiProviders';
import type { ProviderTestResult } from '../../shared/ipc-channels';
import { outboundHeaders, outboundUrl } from '../proxy/upstream';
import type { FetchLike, FetchLikeResponse } from './modelCatalog';

const TEST_TIMEOUT_MS = 25_000;
const MAX_MODELS_TO_TRY = 3;

type ProbeResult = { ok: boolean; latencyMs: number; auth: boolean; unreachable: boolean };

function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function endsWithVersion(base: string): boolean {
  return /\/v\d+(?:[a-z]+\d*)?$/i.test(base);
}

/** HTTP status that means "the server answered" (not auth failure, not silence). */
export function postStatusIndicatesLive(status: number): boolean {
  if (status === 401 || status === 403) return false;
  if (status >= 200 && status < 300) return true;
  return [400, 404, 405, 422, 429, 500, 502, 503, 504].includes(status);
}

function classifyGetStatus(status: number): Pick<ProbeResult, 'ok' | 'auth'> {
  if (status === 401 || status === 403) return { ok: false, auth: true };
  if (status >= 200 && status < 300) return { ok: true, auth: false };
  return { ok: false, auth: false };
}

async function timedFetch(
  fetchImpl: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ response: FetchLikeResponse | null; latencyMs: number }> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return { response, latencyMs: Date.now() - start };
  } catch {
    return { response: null, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

/** GET the model catalog endpoint (mirrors modelCatalog.ts URLs). */
async function catalogGetProbe(
  format: ApiFormat,
  baseUrl: string,
  apiKey: string | null,
  fetchImpl: FetchLike,
): Promise<ProbeResult> {
  const base = normalizeBase(baseUrl);
  let url: string;
  let headers: Record<string, string> = { accept: 'application/json' };

  switch (format) {
    case 'openai':
    case 'openai-responses':
      url = endsWithVersion(base) ? `${base}/models` : `${base}/v1/models`;
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      break;
    case 'anthropic':
      url = endsWithVersion(base) ? `${base}/models` : `${base}/v1/models`;
      headers = { ...headers, ...outboundHeaders('anthropic', apiKey) };
      break;
    case 'gemini': {
      const path = endsWithVersion(base) ? `${base}/models` : `${base}/v1beta/models`;
      url = apiKey ? `${path}?key=${encodeURIComponent(apiKey)}` : path;
      break;
    }
    default:
      return { ok: false, latencyMs: 0, auth: false, unreachable: false };
  }

  const { response, latencyMs } = await timedFetch(fetchImpl, url, { method: 'GET', headers });
  if (!response) return { ok: false, latencyMs, auth: false, unreachable: true };
  const kind = classifyGetStatus(response.status);
  return { ok: kind.ok, latencyMs, auth: kind.auth, unreachable: false };
}

async function postProbe(
  format: ApiFormat,
  baseUrl: string,
  apiKey: string | null,
  modelId: string,
  fetchImpl: FetchLike,
): Promise<ProbeResult> {
  const url = outboundUrl(format, baseUrl);
  const headers = { ...outboundHeaders(format, apiKey), 'Content-Type': 'application/json' };
  const body =
    format === 'anthropic'
      ? JSON.stringify({
          model: modelId,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        })
      : format === 'openai-responses'
        ? JSON.stringify({ model: modelId, input: 'ping', max_output_tokens: 1 })
        : JSON.stringify({
            model: modelId,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          });

  const { response, latencyMs } = await timedFetch(fetchImpl, url, { method: 'POST', headers, body });
  if (!response) return { ok: false, latencyMs, auth: false, unreachable: true };

  if (response.status === 401 || response.status === 403) {
    return { ok: false, latencyMs, auth: true, unreachable: false };
  }
  if (postStatusIndicatesLive(response.status)) {
    return { ok: true, latencyMs, auth: false, unreachable: false };
  }
  return { ok: false, latencyMs, auth: false, unreachable: false };
}

function modelIdsToTry(provider: Provider): string[] {
  const ids: string[] = [];
  for (const m of provider.models.slice(0, MAX_MODELS_TO_TRY)) {
    const wire = wireModelName(m);
    if (wire !== '' && !ids.includes(wire)) ids.push(wire);
  }
  return ids;
}

async function probeFormat(
  format: ApiFormat,
  provider: Provider,
  apiKey: string | null,
  fetchImpl: FetchLike,
): Promise<ProbeResult> {
  const catalog = await catalogGetProbe(format, provider.baseUrl, apiKey, fetchImpl);
  if (catalog.ok || catalog.auth) return catalog;

  let last: ProbeResult = catalog;
  for (const modelId of modelIdsToTry(provider)) {
    const post = await postProbe(format, provider.baseUrl, apiKey, modelId, fetchImpl);
    if (post.ok || post.auth) return post;
    last = post;
  }
  return last;
}

export async function testProviderConnectivity(
  provider: Provider,
  apiKey: string | null,
  fetchImpl: FetchLike,
): Promise<ProviderTestResult> {
  if (provider.models.length === 0) {
    return { ok: false, latencyMs: null, format: null, error: 'no_models' };
  }
  if (!apiKey) {
    return { ok: false, latencyMs: null, format: null, error: 'no_key' };
  }

  let sawAuth = false;
  let sawUnreachable = false;

  for (const format of provider.apiFormats) {
    const result = await probeFormat(format, provider, apiKey, fetchImpl);
    if (result.auth) sawAuth = true;
    if (result.unreachable) sawUnreachable = true;
    if (result.ok) {
      return { ok: true, latencyMs: result.latencyMs, format, error: null };
    }
  }

  if (sawAuth) return { ok: false, latencyMs: null, format: null, error: 'unauthorized' };
  if (sawUnreachable) return { ok: false, latencyMs: null, format: null, error: 'unreachable' };
  return { ok: false, latencyMs: null, format: null, error: 'upstream' };
}
