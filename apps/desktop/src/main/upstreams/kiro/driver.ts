// The Kiro upstream driver: the account kiro-cli or the Kiro IDE is signed in to (an
// agent-import provider with agentId 'kiro'), served by Kiro's own API.
//
// Kiro has no OpenAI- or Anthropic-compatible endpoint. Each request is sent whole as a
// conversation to `runtime.<region>.kiro.dev/generateAssistantResponse` (the API kiro-cli
// talks to; ./body.ts), and the AWS event stream it answers with is read as driver events
// (./eventStream.ts). The models are Kiro's `List-Available-Models` for the account.
//
// The token is read from kiro-cli / the IDE per request (./auth.ts) and never leaves main.
// Ported from magpie's Kiro plugin.

import { randomUUID } from 'node:crypto';
import type { Provider, ProviderModel } from '../../../shared/aiProviders';
import { providerUsesAgentImport } from '../../../shared/oauthProviders';
import type { ProxyFetchResponse } from '../../proxy/upstream';
import { noCredentialError, UpstreamError, type UpstreamDriver } from '../types';
import { kiroManagement, kiroRuntime, type KiroAccount, type KiroAuth } from './auth';
import { kiroBody, kiroThinks } from './body';
import { kiroEvents, readFrames } from './eventStream';

export const KIRO_DRIVER_ID = 'kiro';

/** Used until Kiro's own list is read: Auto picks a model for each request. */
export const KIRO_FALLBACK_MODELS: readonly ProviderModel[] = [{ id: 'auto', catalogName: 'Auto', reasoning: true }];

/** fetch as Kiro needs it (a GET without a body, too). */
export type KiroFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<ProxyFetchResponse>;

export interface KiroDriverDeps {
  fetchImpl: KiroFetch;
  auth: KiroAuth;
}

export function isKiroProvider(provider: Pick<Provider, 'credentialMode' | 'agentImport'>): boolean {
  return providerUsesAgentImport(provider.credentialMode) && (provider.agentImport?.agentId as string | undefined) === 'kiro';
}

function userAgent(): string {
  const v = '1.28.3';
  return `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#${v} m/E app/AmazonQ-For-CLI md/appVersion-${v}-${randomUUID().replaceAll('-', '')}`;
}

/** The status a refusal is passed on as (Kiro's words stay main-side). */
export function kiroFailureStatus(status: number, text: string): number {
  if (/CONTENT_LENGTH_EXCEEDS_THRESHOLD|input is too long/i.test(text)) return 400;
  if (/INSUFFICIENT_MODEL_CAPACITY/.test(text)) return 503;
  if (/MONTHLY_REQUEST_COUNT|USAGE_LIMIT/.test(text)) return 429;
  return status;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

export function kiroModelsFrom(raw: unknown): { models: ProviderModel[]; windows: Map<string, number> } {
  const out: ProviderModel[] = [];
  const windows = new Map<string, number>();
  const env = isObj(raw) ? raw : {};
  const def = isObj(env.defaultModel) && typeof env.defaultModel.modelId === 'string' ? env.defaultModel.modelId : '';
  for (const m of Array.isArray(env.models) ? env.models : []) {
    if (!isObj(m) || typeof m.modelId !== 'string' || !m.modelId) continue;
    const id = m.modelId;
    if (out.some((x) => x.id === id)) continue;
    let name = typeof m.modelName === 'string' && m.modelName && m.modelName !== id ? m.modelName : '';
    if (!name && id === 'auto') name = 'Auto';
    const model: ProviderModel = { id, ...(name ? { catalogName: name } : {}), ...(kiroThinks(id) ? { reasoning: true } : {}) };
    const limits = isObj(m.tokenLimits) ? m.tokenLimits : {};
    if (typeof limits.maxInputTokens === 'number' && limits.maxInputTokens > 0) windows.set(id, limits.maxInputTokens);
    if (id === def) out.unshift(model);
    else out.push(model);
  }
  return { models: out, windows };
}

export function createKiroDriver(deps: KiroDriverDeps): UpstreamDriver {
  /** Each model's context window, as Kiro last listed it. */
  const windows = new Map<string, number>();

  const send = (a: KiroAccount, body: string, signal?: AbortSignal) => {
    const ua = userAgent();
    return deps.fetchImpl(`${kiroRuntime(a.region)}/generateAssistantResponse`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${a.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.amazon.eventstream',
        'x-amzn-codewhisperer-optout': 'true',
        'amz-sdk-invocation-id': randomUUID(),
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amzn-kiro-agent-mode': 'vibe',
        'x-amz-user-agent': ua,
        'User-Agent': ua,
      },
      body,
      signal,
    });
  };

  return {
    id: KIRO_DRIVER_ID,
    handles: isKiroProvider,
    bind() {
      return {
        driverId: KIRO_DRIVER_ID,
        async listModels(signal) {
          const a = await deps.auth.current(signal);
          if (!a) throw noCredentialError();
          const q = new URLSearchParams({ origin: 'KIRO_CLI', ...(a.profile ? { profileArn: a.profile } : {}) });
          let res;
          try {
            res = await deps.fetchImpl(`${kiroManagement(a.region)}/List-Available-Models?${q}`, {
              method: 'GET',
              headers: { Authorization: `Bearer ${a.token}`, Accept: 'application/json' },
              signal,
            });
          } catch {
            return [...KIRO_FALLBACK_MODELS];
          }
          if (res.status === 401 || res.status === 403) throw new UpstreamError({ status: 401, message: 'rejected' });
          if (!res.ok) return [...KIRO_FALLBACK_MODELS];
          let raw: unknown;
          try {
            raw = JSON.parse(await res.text());
          } catch {
            return [...KIRO_FALLBACK_MODELS];
          }
          const got = kiroModelsFrom(raw);
          for (const [k, v] of got.windows) windows.set(k, v);
          return got.models.length ? got.models : [...KIRO_FALLBACK_MODELS];
        },
        async chat(input, signal) {
          let a = await deps.auth.current(signal);
          if (!a) return { error: { status: 401, message: 'no credential' } };
          const conversationId = randomUUID();
          let req = kiroBody(input, a.profile, conversationId);
          let res: ProxyFetchResponse;
          try {
            res = await send(a, req.body, signal);
            if (res.status === 403) {
              // Kiro turned the token down: renewed once, then again.
              await res.body?.cancel().catch(() => undefined);
              a = await deps.auth.current(signal, true);
              if (!a) return { error: { status: 401, message: 'rejected' } };
              req = kiroBody(input, a.profile, conversationId);
              res = await send(a, req.body, signal);
            }
          } catch (e) {
            if ((e as { name?: string } | null)?.name === 'AbortError') throw e;
            return { error: { status: 502, message: 'network error' } };
          }
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            const status = res.status === 403 ? 401 : kiroFailureStatus(res.status, text);
            return { error: { status, message: 'rejected' } };
          }
          if (!res.body) return { error: { status: 502, message: 'empty answer' } };
          const model = typeof input.model === 'string' && input.model ? input.model : 'auto';
          return {
            events: kiroEvents(readFrames(res.body), {
              thinking: req.budget > 0,
              names: req.names,
              contextWindow: windows.get(model) ?? 0,
            }),
          };
        },
      };
    },
  };
}
