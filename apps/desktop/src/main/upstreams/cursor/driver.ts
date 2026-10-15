// The Cursor upstream driver: a signed-in cursor-agent session (agent-import provider with
// agentId 'cursor') served by Cursor's agent API through ./client.ts.
//
// The session token is read from cursor-agent's own store at call time (renewed through
// `cursor-agent status` when near expiry — ./agentCli.ts); it is never copied into
// AiOpt's secret store and never leaves main.

import type { Provider } from '../../../shared/aiProviders';
import { providerUsesAgentImport } from '../../../shared/oauthProviders';
import { noCredentialError, type UpstreamDriver } from '../types';
import type { CursorClient } from './client';
import type { ChatRequest } from './conversation';
import { offersReasoning } from './models';

export const CURSOR_DRIVER_ID = 'cursor';

export interface CursorDriverDeps {
  client: CursorClient;
  /** The session token (renewed when near expiry), or null when signed out. */
  token: () => Promise<string | null>;
}

/** Whether the provider is a signed-in cursor-agent session. */
export function isCursorProvider(provider: Pick<Provider, 'credentialMode' | 'agentImport'>): boolean {
  return providerUsesAgentImport(provider.credentialMode) && provider.agentImport?.agentId === 'cursor';
}

export function createCursorDriver(deps: CursorDriverDeps): UpstreamDriver {
  return {
    id: CURSOR_DRIVER_ID,
    handles: isCursorProvider,
    bind() {
      return {
        driverId: CURSOR_DRIVER_ID,
        async listModels(signal) {
          const tok = await deps.token();
          if (!tok) throw noCredentialError();
          const raw = await deps.client.models(tok, signal);
          return raw.map((m) => ({
            id: m.id,
            ...(m.name && m.name !== m.id ? { catalogName: m.name } : {}),
            ...(offersReasoning(m) ? { reasoning: true } : {}),
          }));
        },
        async chat(body, signal) {
          const tok = await deps.token();
          if (!tok) return { error: { status: 401, message: 'no credential' } };
          return deps.client.chat(tok, body as ChatRequest, signal);
        },
      };
    },
  };
}
