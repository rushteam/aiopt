// Outbound request construction for the translation proxy.
//
// The URL-path + auth-header conventions here MIRROR modelCatalog.ts (the other place
// AiOpt talks to a provider), including its `endsWithVersion` handling of base URLs
// that already carry a `/v1`-style segment. The two differ only in the endpoint:
// modelCatalog GETs `/models`; the proxy POSTs the chat/messages endpoint and streams
// the response back.
//
// The URL/header builders are pure and unit-tested. The transport itself (`ProxyFetch`)
// is injected — production passes Electron's `net.fetch`; tests pass a stub — so this
// module never imports Electron. The real key is placed into the outbound headers HERE
// and nowhere else; callers must never log the returned header map.

import type { ApiFormat } from '../../shared/aiProviders';

/** Response shape the proxy depends on — satisfied by WHATWG `fetch` / Electron `net.fetch`. */
export interface ProxyFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

/** The injected streaming transport (POST + body + streamed response). */
export type ProxyFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<ProxyFetchResponse>;

/** Strip trailing slashes so we can append a path segment safely (as modelCatalog does). */
function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** Does the base URL already end in a version segment (`/v1`, `/v1beta`, …)? */
function endsWithVersion(base: string): boolean {
  return /\/v\d+(?:[a-z]+\d*)?$/i.test(base);
}

/** Build the outbound endpoint URL for the provider's (outbound) format. */
export function outboundUrl(outboundFormat: ApiFormat, baseUrl: string): string {
  const base = normalizeBase(baseUrl);
  switch (outboundFormat) {
    case 'openai':
      return endsWithVersion(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    case 'anthropic':
      return endsWithVersion(base) ? `${base}/messages` : `${base}/v1/messages`;
    case 'openai-responses':
      // Only reached by a same-format passthrough route (Responses → Responses).
      return endsWithVersion(base) ? `${base}/responses` : `${base}/v1/responses`;
    default:
      // gemini is not a proxy target; routes never carry it.
      throw new Error(`unsupported outbound format: ${outboundFormat}`);
  }
}

/**
 * Build the outbound auth + content headers. The real provider key is injected here;
 * the caller must forward these headers only to the upstream and NEVER log them.
 */
export function outboundHeaders(
  outboundFormat: ApiFormat,
  apiKey: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  switch (outboundFormat) {
    case 'openai':
    case 'openai-responses':
      // Both OpenAI dialects authenticate with a bearer token.
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      break;
    case 'anthropic':
      headers['anthropic-version'] = '2023-06-01';
      if (apiKey) headers['x-api-key'] = apiKey;
      break;
    default:
      throw new Error(`unsupported outbound format: ${outboundFormat}`);
  }
  return headers;
}
