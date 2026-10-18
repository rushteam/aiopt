// CodeArts SnapEngine upstream driver.
//
// Serves oauth providers with kind `huawei_codearts`. Chat is OpenAI Chat
// Completions at snap-access, signed with temporary STS credentials
// (SDK-HMAC-SHA256). Free-quota (benefit) models carry a signed `maas_type`
// header. Tokens never leave main; reply bodies are never logged.

import { randomBytes } from 'node:crypto';
import type { Provider, ProviderModel } from '../../../shared/aiProviders';
import { providerUsesOAuth } from '../../../shared/oauthProviders';
import type { ProxyFetchResponse } from '../../proxy/upstream';
import { readChatSse } from '../openaiChatIn';
import { noCredentialError, UpstreamError, type UpstreamDriver } from '../types';
import type { CodeArtsAuth } from './auth';
import { CODEARTS_CHAT_BASE } from './constants';
import {
  codeArtsFallbackModels,
  createBenefitModelSet,
  fetchCodeArtsRemoteModels,
} from './models';
import type { CodeArtsSession } from './session';
import { signRequestHuawei } from './sign';

export const CODEARTS_DRIVER_ID = 'codearts';

export type CodeArtsFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<ProxyFetchResponse>;

export interface CodeArtsDriverDeps {
  fetchImpl: CodeArtsFetch;
  auth: CodeArtsAuth;
}

export function isCodeArtsOAuthProvider(
  provider: Pick<Provider, 'credentialMode' | 'oauth'>,
): boolean {
  return providerUsesOAuth(provider.credentialMode) && provider.oauth?.kind === 'huawei_codearts';
}

function hex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

function chatUrl(): string {
  return `${CODEARTS_CHAT_BASE}/chat/completions`;
}

function signedChatHeaders(
  session: CodeArtsSession,
  body: string,
  benefit: boolean,
): Record<string, string> {
  const signed = signRequestHuawei({
    accessKeyId: session.accessKeyId,
    secretAccessKey: session.secretAccessKey,
    securityToken: session.securityToken,
    method: 'POST',
    url: chatUrl(),
    body,
    extraHeaders: benefit ? { maas_type: 'benefit' } : undefined,
  });
  // Unsigned product headers — must NOT participate in the canonical request.
  return {
    ...signed,
    'Chat-Id': hex(16),
    'Session-Id': hex(16),
    lang: 'en',
    Accept: 'text/event-stream',
  };
}

export function createCodeArtsDriver(deps: CodeArtsDriverDeps): UpstreamDriver {
  const benefit = createBenefitModelSet();

  return {
    id: CODEARTS_DRIVER_ID,
    handles: isCodeArtsOAuthProvider,
    bind(provider) {
      const providerId = provider.id;
      return {
        driverId: CODEARTS_DRIVER_ID,
        async listModels(signal) {
          const session = await deps.auth.current(providerId, signal);
          if (!session) throw noCredentialError();
          try {
            const live = await fetchCodeArtsRemoteModels(session, deps.fetchImpl, benefit, signal);
            return live.length ? live : codeArtsFallbackModels();
          } catch (e) {
            if (e instanceof UpstreamError) throw e;
            return codeArtsFallbackModels();
          }
        },
        async chat(input, signal) {
          const session = await deps.auth.current(providerId, signal);
          if (!session) return { error: { status: 401, message: 'no credential' } };

          const bodyObj: Record<string, unknown> =
            input && typeof input === 'object' ? { ...input, stream: true } : { stream: true };
          const model = typeof bodyObj.model === 'string' ? bodyObj.model : '';
          const body = JSON.stringify(bodyObj);
          const headers = signedChatHeaders(session, body, benefit.has(model));

          let res: ProxyFetchResponse;
          try {
            res = await deps.fetchImpl(chatUrl(), {
              method: 'POST',
              headers,
              body,
              signal,
            });
          } catch (e) {
            if ((e as { name?: string } | null)?.name === 'AbortError') throw e;
            return { error: { status: 502, message: 'network error' } };
          }

          if (res.status === 401 || res.status === 403) {
            return { error: { status: 401, message: 'rejected' } };
          }
          if (!res.ok) {
            return { error: { status: res.status, message: 'rejected' } };
          }
          if (!res.body) return { error: { status: 502, message: 'empty answer' } };

          const type = res.headers.get('content-type') ?? '';
          if (/json/i.test(type) && !/event-stream/i.test(type)) {
            // Unexpected JSON envelope on a streamed chat — treat as refusal.
            return { error: { status: 502, message: 'rejected' } };
          }
          return { events: readChatSse(res.body) };
        },
      };
    },
  };
}

/** Exported for tests that need a static fallback list without hitting the network. */
export function codeArtsDriverFallbackModels(): readonly ProviderModel[] {
  return CODEARTS_FALLBACK_MODELS_COPY;
}

const CODEARTS_FALLBACK_MODELS_COPY: readonly ProviderModel[] = codeArtsFallbackModels();
