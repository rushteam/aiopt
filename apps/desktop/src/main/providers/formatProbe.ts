// Format probe — ask a base URL which wire formats it serves, without spending tokens.
//
// A gateway often serves several dialects at one base (OpenAI Chat Completions AND
// Responses, or Chat Completions AND Anthropic Messages), and a user rarely knows the
// list. Rather than make them guess, this fires one cheap request per format and reads
// the answer's SHAPE, not its content:
//
//   - The three POST dialects are probed with an EMPTY JSON body. A server that serves
//     the endpoint rejects it as invalid (400/422 — "model is required") or rate-limits
//     it (429); one that does not serve it says so (404/405). Either way no model runs and
//     no tokens are billed. A 200 also counts as served (a permissive gateway).
//   - Gemini has no equivalent, so it is probed with the same GET catalog call
//     modelCatalog uses, and counts only when the reply carries a `models` list — so an
//     OpenAI-compatible server that happens to answer `/models` is not mistaken for it.
//   - 401/403 is INCONCLUSIVE for a single endpoint (an auth layer may sit in front of the
//     router and reject every path alike), so it never marks a format as served. When NO
//     format is served and at least one endpoint said 401/403, the key is the likelier
//     problem and UNAUTHORIZED is thrown so the user fixes that first.
//
// Like modelCatalog this is a privileged outbound capability: main-only, transport
// injected, and nothing thrown or logged may carry the key or a response body. The URL
// and header conventions are upstream.ts's (the proxy's), so a format detected here is
// exactly one the proxy will later call.

import { API_FORMATS, type ApiFormat } from '../../shared/aiProviders';
import { throwIpcError } from '../ipc/validate';
import { outboundHeaders, outboundUrl } from '../proxy/upstream';
import type { FetchLike, FetchLikeResponse } from './modelCatalog';

export interface DetectFormatsInput {
  baseUrl: string;
  /** Resolved main-side; may be null when nothing is stored or typed yet. */
  apiKey: string | null;
}

/** Per-probe budget. Probes run in parallel, so this bounds the whole detection too. */
const PROBE_TIMEOUT_MS = 10_000;

/** What one probe learned about one endpoint. */
type ProbeOutcome = 'served' | 'auth' | 'absent' | 'unreachable';

/** Strip trailing slashes so we can append a path segment safely (as modelCatalog does). */
function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** Does the base URL already end in a version segment (`/v1`, `/v1beta`, …)? */
function endsWithVersion(base: string): boolean {
  return /\/v\d+(?:[a-z]+\d*)?$/i.test(base);
}

/** Classify a POST-probe reply by status alone (the body may echo the request). */
function classifyPostStatus(status: number): ProbeOutcome {
  if (status === 200 || status === 400 || status === 422 || status === 429) return 'served';
  if (status === 401 || status === 403) return 'auth';
  return 'absent';
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<FetchLikeResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    // Network failure, DNS, TLS, or timeout. The original error is dropped on purpose —
    // it can echo the request, which carries the key.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** POST `{}` to the dialect's endpoint and read whether the endpoint exists. */
async function probePostDialect(
  format: 'openai' | 'openai-responses' | 'anthropic',
  input: DetectFormatsInput,
  fetchImpl: FetchLike,
): Promise<ProbeOutcome> {
  const response = await fetchWithTimeout(fetchImpl, outboundUrl(format, input.baseUrl), {
    method: 'POST',
    headers: outboundHeaders(format, input.apiKey),
    body: '{}',
  });
  return response ? classifyPostStatus(response.status) : 'unreachable';
}

/** GET the Gemini catalog and count it only when the reply is shaped like one. */
async function probeGemini(input: DetectFormatsInput, fetchImpl: FetchLike): Promise<ProbeOutcome> {
  const base = normalizeBase(input.baseUrl);
  const path = endsWithVersion(base) ? `${base}/models` : `${base}/v1beta/models`;
  const url = input.apiKey ? `${path}?key=${encodeURIComponent(input.apiKey)}` : path;
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (!response) return 'unreachable';
  if (response.status === 401 || response.status === 403) return 'auth';
  if (!response.ok) return 'absent';
  try {
    const body = (await response.json()) as { models?: unknown } | null;
    return body && Array.isArray(body.models) ? 'served' : 'absent';
  } catch {
    return 'absent';
  }
}

function probe(format: ApiFormat, input: DetectFormatsInput, fetchImpl: FetchLike): Promise<ProbeOutcome> {
  switch (format) {
    case 'openai':
    case 'openai-responses':
    case 'anthropic':
      return probePostDialect(format, input, fetchImpl);
    case 'gemini':
      return probeGemini(input, fetchImpl);
    default:
      return Promise.resolve('absent');
  }
}

/**
 * Detect the formats a base URL serves. Returns the served formats in canonical
 * ({@link API_FORMATS}) order — possibly empty, when every endpoint answered but none
 * matched. Throws UNAUTHORIZED when nothing was served and some endpoint rejected the
 * key, and UPSTREAM_ERROR when no endpoint could be reached at all. `fetchImpl` is
 * injected (main passes Electron's `net.fetch`; tests pass a stub).
 */
export async function detectProviderFormats(
  input: DetectFormatsInput,
  fetchImpl: FetchLike,
): Promise<ApiFormat[]> {
  if (input.baseUrl.trim() === '') throwIpcError('INVALID_PARAMS', 'baseUrl is required');
  const outcomes = await Promise.all(API_FORMATS.map((format) => probe(format, input, fetchImpl)));
  const served = API_FORMATS.filter((_, i) => outcomes[i] === 'served');
  if (served.length > 0) return served;
  if (outcomes.includes('auth')) throwIpcError('UNAUTHORIZED', 'the provider rejected the API key');
  if (outcomes.every((o) => o === 'unreachable')) {
    throwIpcError('UPSTREAM_ERROR', 'could not reach the provider');
  }
  return [];
}
