// Upstream drivers: providers that are not served by a plain HTTP POST to an
// OpenAI / Anthropic / Gemini compatible endpoint.
//
// Most providers are just a base URL + a key, and the translation proxy forwards to them
// itself. A few (Cursor's agent API: Connect + protobuf over HTTP/2) speak a private
// protocol. Each such protocol is a built-in DRIVER under main/upstreams/<id>/, listed in
// the composition root (services.ts). Drivers are compiled in — never loaded at runtime —
// because they run in main next to every credential (see docs/dev-rules/upstream-drivers.md).
//
// The contract is OpenAI Chat in, OpenAI-Chat-shaped events out: the proxy has already
// translated the inbound dialect to OpenAI Chat (the route's outbound format) and maps the
// events back through the same response transforms, so every inbound dialect works.

import type { Provider, ProviderModel } from '../../shared/aiProviders';

/** Token counts in OpenAI Chat `usage` shape. */
export interface UpstreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

/** A coded failure. `message` is the upstream's own text: main-side only, never sent on. */
export interface UpstreamFailure {
  status: number;
  message: string;
}

/** One step of an answer. */
export type UpstreamEvent =
  | { text: string }
  | { reasoning: string }
  | { tool: { index: number; id: string; name: string; args: string } }
  | { stop: 'stop' | 'tool_calls'; usage: UpstreamUsage }
  | { error: UpstreamFailure };

/** A request refused up front, or an answer to stream. */
export type UpstreamChatResult = { error: UpstreamFailure } | { events: AsyncIterable<UpstreamEvent> };

/** An OpenAI Chat Completions request body (loosely typed; drivers read what they need). */
export type OpenAiChatBody = Record<string, unknown>;

/** A failure thrown by a driver's unary calls (model listing). Carries only the status. */
export class UpstreamError extends Error {
  constructor(
    readonly failure: UpstreamFailure,
    /** True when there was no credential to send at all (signed out), not a rejection. */
    readonly noCredential = false,
  ) {
    super(failure.message);
  }
}

/** The error for "no credential to send" (signed out / expired and not renewable). */
export const noCredentialError = (): UpstreamError => new UpstreamError({ status: 401, message: 'no credential' }, true);

/** An UpstreamError's status, or null for anything else (a bug, an abort). */
export function upstreamErrorStatus(e: unknown): number | null {
  return e instanceof UpstreamError ? e.failure.status : null;
}

/** A driver bound to one provider: its credential is resolved inside, per call. */
export interface BoundUpstream {
  /** The driver id, for logs (`upstream: <id>`). */
  readonly driverId: string;
  /** The provider's models. Throws UpstreamError (401 when signed out / rejected). */
  listModels(signal?: AbortSignal): Promise<ProviderModel[]>;
  /** One OpenAI Chat request. `{ error: { status: 401 } }` when there is no credential. */
  chat(body: OpenAiChatBody, signal?: AbortSignal): Promise<UpstreamChatResult>;
}

export interface UpstreamDriver {
  readonly id: string;
  /** Whether this driver serves the provider (decided from the stored record alone). */
  handles(provider: Provider): boolean;
  bind(provider: Provider): BoundUpstream;
}

export interface UpstreamRegistry {
  /** The bound driver serving this provider, or null when it is a plain HTTP provider. */
  forProvider(provider: Provider | null | undefined): BoundUpstream | null;
}

export function createUpstreamRegistry(drivers: readonly UpstreamDriver[]): UpstreamRegistry {
  const ids = new Set<string>();
  for (const d of drivers) {
    if (ids.has(d.id)) throw new Error(`duplicate upstream driver: ${d.id}`);
    ids.add(d.id);
  }
  return {
    forProvider(provider) {
      if (!provider) return null;
      const d = drivers.find((x) => x.handles(provider));
      return d ? d.bind(provider) : null;
    },
  };
}
