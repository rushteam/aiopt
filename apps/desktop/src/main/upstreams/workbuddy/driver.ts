// The WorkBuddy upstream driver: WorkBuddy desktop's signed-in account (agent-import
// provider with agentId 'workbuddy') served by WorkBuddy's chat endpoint.
//
// WorkBuddy's endpoint is OpenAI Chat Completions at `copilot.tencent.com/v2`, but only for
// a request that looks like WorkBuddy's own: its headers (./auth.ts signHeaders), streamed,
// with its body rules (./body.ts). This driver adds those, names each request's conversation
// and turn as WorkBuddy's client does (so one user send counts once in its usage detail),
// and names the model's tool calls back to the client's own tool names.
//
// The account's token is read from the app's own file per request (./auth.ts) and never
// leaves main.

import { createHash, randomBytes } from 'node:crypto';
import type { Provider, ProviderModel } from '../../../shared/aiProviders';
import { providerUsesAgentImport } from '../../../shared/oauthProviders';
import type { ProxyFetchResponse } from '../../proxy/upstream';
import { readChatSse } from '../openaiChatIn';
import { noCredentialError, UpstreamError, type UpstreamDriver, type UpstreamEvent } from '../types';
import { WORKBUDDY_ENDPOINT, WORKBUDDY_UA_VERSION, signHeaders, type WorkBuddyAccount } from './auth';
import { replyAfterTools, workbuddyBody } from './body';

export const WORKBUDDY_DRIVER_ID = 'workbuddy';

/** WorkBuddy (China build)'s models, used when its config can't be read. */
export const WORKBUDDY_FALLBACK_MODELS: readonly ProviderModel[] = [
  { id: 'auto', catalogName: 'Auto' },
  { id: 'hy3', catalogName: 'Hy3', reasoning: true },
  { id: 'glm-5.3', catalogName: 'GLM-5.3', reasoning: true },
  { id: 'glm-5.3-flash', catalogName: 'GLM-5.3-Flash', reasoning: true },
  { id: 'glm-5.2', catalogName: 'GLM-5.2', reasoning: true },
  { id: 'kimi-k3-1', catalogName: 'Kimi-K3', reasoning: true },
  { id: 'minimax-m3', catalogName: 'MiniMax-M3' },
  { id: 'deepseek-v4-pro', catalogName: 'Deepseek-V4-Pro', reasoning: true },
  { id: 'deepseek-v4.1-flash', catalogName: 'Deepseek-V4.1-Flash' },
];

/** fetch as WorkBuddy needs it (a GET without a body, too). */
export type WorkBuddyFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<ProxyFetchResponse>;

export interface WorkBuddyDriverDeps {
  fetchImpl: WorkBuddyFetch;
  /** The signed-in account, its token fresh; null when WorkBuddy desktop is signed out. */
  account: (signal?: AbortSignal) => Promise<WorkBuddyAccount | null>;
}

export function isWorkBuddyProvider(provider: Pick<Provider, 'credentialMode' | 'agentImport'>): boolean {
  return providerUsesAgentImport(provider.credentialMode) && provider.agentImport?.agentId === 'workbuddy';
}

// ---- request ids -------------------------------------------------------------------------

// Derived ids say nothing of the words they are made from (per-process salt).
const SALT = randomBytes(16).toString('hex');
const hex = (): string => randomBytes(16).toString('hex');
const idFor = (kind: string, key: string): string =>
  createHash('sha256').update(`${SALT}|${kind}|${key}`).digest('hex').slice(0, 32);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function signatureOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    const type = isObj(part) && typeof part.type === 'string' ? part.type : '';
    if (type === '' || type === 'text') out += isObj(part) && typeof part.text === 'string' ? part.text : '';
    else if (type !== 'tool_result' && type !== 'tool-result') {
      out += `[${type}:${createHash('sha256').update(JSON.stringify(part)).digest('hex').slice(0, 8)}]`;
    }
  }
  return out;
}

function answeredBefore(msgs: unknown[], i: number): boolean {
  const prev = msgs[i - 1];
  if (!isObj(prev)) return false;
  if (prev.role === 'tool') return true;
  return prev.role === 'assistant' && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0;
}

/** The conversation / turn / message ids WorkBuddy's client sends with a chat. */
export function conversationHeaders(body: Obj): Record<string, string> {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  let conv = '';
  for (const m of msgs) {
    if (!isObj(m) || m.role !== 'user') continue;
    const sig = signatureOf(m.content);
    if (sig) {
      conv = `first:${sig}`;
      break;
    }
  }
  let turn = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!isObj(m) || m.role !== 'user' || answeredBefore(msgs, i)) continue;
    const sig = signatureOf(m.content);
    turn = sig ? `u${i}:${sig}` : '';
    break;
  }
  const msg = hex();
  return {
    'X-Conversation-Message-ID': msg,
    'X-Request-ID': msg,
    'X-Conversation-Request-ID': turn ? idFor('turn', `${conv}|${turn}`) : hex(),
    ...(conv ? { 'X-Conversation-ID': idFor('conversation', conv) } : {}),
  };
}

// ---- answers -----------------------------------------------------------------------------

/** WorkBuddy's 400 "the conversation must end with a user message" (code 11153). */
const AFTER_TOOLS_REFUSED = /must end with a user message|["']code["']\s*:\s*["']?11153(?![\d.])/i;

async function* named(events: AsyncIterable<UpstreamEvent>, names: Map<string, string>): AsyncGenerator<UpstreamEvent> {
  for await (const e of events) {
    if ('tool' in e && names.has(e.tool.name)) yield { tool: { ...e.tool, name: names.get(e.tool.name)! } };
    else yield e;
  }
}

async function readModels(res: ProxyFetchResponse): Promise<ProviderModel[]> {
  let env: { code?: unknown; data?: { agents?: unknown; models?: unknown } };
  try {
    env = JSON.parse(await res.text()) as typeof env;
  } catch {
    return [];
  }
  if (env.code) return [];
  const cfg = env.data ?? {};
  const details = Array.isArray(cfg.models) ? cfg.models.filter(isObj) : [];
  const out: ProviderModel[] = [];
  for (const agent of Array.isArray(cfg.agents) ? cfg.agents : []) {
    if (!isObj(agent) || agent.name !== 'cli' || !Array.isArray(agent.models)) continue;
    for (const id of agent.models) {
      if (typeof id !== 'string' || !id || out.some((m) => m.id === id)) continue;
      const d = details.find((x) => x.id === id);
      const name = d && typeof d.name === 'string' && d.name !== id ? d.name : undefined;
      const efforts = d && isObj(d.reasoning) && Array.isArray(d.reasoning.supportedEfforts) ? d.reasoning.supportedEfforts : [];
      out.push({ id, ...(name ? { catalogName: name } : {}), ...(efforts.length ? { reasoning: true } : {}) });
    }
  }
  return out;
}

export function createWorkBuddyDriver(deps: WorkBuddyDriverDeps): UpstreamDriver {
  return {
    id: WORKBUDDY_DRIVER_ID,
    handles: isWorkBuddyProvider,
    bind() {
      return {
        driverId: WORKBUDDY_DRIVER_ID,
        async listModels(signal) {
          const a = await deps.account(signal);
          if (!a) throw noCredentialError();
          let res;
          try {
            res = await deps.fetchImpl(`${WORKBUDDY_ENDPOINT}/v3/config`, {
              method: 'GET',
              headers: {
                ...signHeaders(a),
                // The CLI User-Agent picks the config with the `cli` agent's models.
                'User-Agent': `CLI/2.0.0 WorkBuddy/${WORKBUDDY_UA_VERSION}`,
                Accept: 'application/json',
              },
              signal,
            });
          } catch {
            return [...WORKBUDDY_FALLBACK_MODELS];
          }
          if (res.status === 401 || res.status === 403) throw new UpstreamError({ status: 401, message: 'rejected' });
          if (!res.ok) return [...WORKBUDDY_FALLBACK_MODELS];
          const live = await readModels(res);
          return live.length ? live : [...WORKBUDDY_FALLBACK_MODELS];
        },
        async chat(input, signal) {
          const a = await deps.account(signal);
          if (!a) return { error: { status: 401, message: 'no credential' } };
          const { body, names } = workbuddyBody(input);
          const headers = {
            ...signHeaders(a),
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...conversationHeaders(body),
          };
          const send = (b: Obj) =>
            deps.fetchImpl(`${WORKBUDDY_ENDPOINT}/v2/chat/completions`, {
              method: 'POST',
              headers,
              body: JSON.stringify(b),
              signal,
            });
          let res: ProxyFetchResponse;
          try {
            res = await send(body);
            if (res.status === 400) {
              const text = await res.text().catch(() => '');
              const again = AFTER_TOOLS_REFUSED.test(text) ? replyAfterTools(body) : null;
              if (!again) return { error: { status: 400, message: 'rejected' } };
              res = await send(again);
            }
          } catch {
            return { error: { status: 502, message: 'network error' } };
          }
          if (!res.ok) {
            // WorkBuddy answers some refusals 200 with a `{code}` envelope; others by status.
            return { error: { status: res.status === 403 ? 403 : res.status, message: 'rejected' } };
          }
          if (!res.body) return { error: { status: 502, message: 'empty answer' } };
          const type = res.headers.get('content-type') ?? '';
          if (/json/i.test(type)) {
            // A JSON answer to a streamed request is an error envelope (`{code, msg}`).
            const text = await res.text().catch(() => '');
            const code = (() => {
              try {
                return Number((JSON.parse(text) as { code?: unknown }).code) || 0;
              } catch {
                return 0;
              }
            })();
            return { error: { status: code === 10085 || code === 11140 ? 403 : code === 14018 ? 429 : 502, message: 'refused' } };
          }
          return { events: named(readChatSse(res.body), names) };
        },
      };
    },
  };
}
