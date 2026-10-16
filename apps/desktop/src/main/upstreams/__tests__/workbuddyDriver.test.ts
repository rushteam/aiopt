import { describe, expect, it } from 'vitest';
import type { ProxyFetchResponse } from '../../proxy/upstream';
import { createWorkBuddyAuth, type WorkBuddyAccount } from '../workbuddy/auth';
import { conversationHeaders, createWorkBuddyDriver, type WorkBuddyFetch, WORKBUDDY_FALLBACK_MODELS } from '../workbuddy/driver';
import type { UpstreamEvent } from '../types';
import type { Provider } from '../../../shared/aiProviders';

const account: WorkBuddyAccount = { access: 'tok', refresh: 'r', expires: 0, refreshExpiresAt: 0, domain: '', uid: 'u1', name: 'Bo' };

function response(status: number, text: string, type = 'text/event-stream'): ProxyFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (n.toLowerCase() === 'content-type' ? type : null) },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
    text: () => Promise.resolve(text),
  };
}

const provider = { id: 'p', credentialMode: 'agent_import', agentImport: { agentId: 'workbuddy' } } as unknown as Provider;

async function all(it: AsyncIterable<UpstreamEvent>): Promise<UpstreamEvent[]> {
  const out: UpstreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('WorkBuddy driver', () => {
  it('handles only WorkBuddy imports', () => {
    const d = createWorkBuddyDriver({ fetchImpl: () => Promise.reject(new Error('x')), account: () => Promise.resolve(account) });
    expect(d.handles(provider)).toBe(true);
    expect(d.handles({ ...provider, agentImport: { agentId: 'codex' } } as Provider)).toBe(false);
  });

  it("sends WorkBuddy's headers and names tool calls back", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'a_b', arguments: '{}' } }] } }] })}\n\n` +
      'data: [DONE]\n\n';
    const fetchImpl: WorkBuddyFetch = (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return Promise.resolve(response(200, sse));
    };
    const bound = createWorkBuddyDriver({ fetchImpl, account: () => Promise.resolve(account) }).bind(provider);
    const r = await bound.chat({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'a.b' } }] });
    if (!('events' in r)) throw new Error('expected events');
    const out = await all(r.events);
    expect(out[0]).toEqual({ tool: { index: 0, id: 'c', name: 'a.b', args: '{}' } });
    expect(calls[0]!.url).toBe('https://copilot.tencent.com/v2/chat/completions');
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer tok', 'User-Agent': 'WorkBuddy/5.5.6', 'X-User-Id': 'u1' });
    expect(JSON.parse(calls[0]!.body!).stream).toBe(true);
  });

  it('retries a "must end with a user message" refusal with an empty reply', async () => {
    const bodies: string[] = [];
    const fetchImpl: WorkBuddyFetch = (_url, init) => {
      bodies.push(init.body!);
      return Promise.resolve(bodies.length === 1 ? response(400, '{"code":11153}', 'application/json') : response(200, 'data: [DONE]\n\n'));
    };
    const bound = createWorkBuddyDriver({ fetchImpl, account: () => Promise.resolve(account) }).bind(provider);
    const r = await bound.chat({ messages: [{ role: 'tool', content: 'r' }, { role: 'user', content: 'go' }] });
    expect('events' in r).toBe(true);
    expect(JSON.parse(bodies[1]!).messages.map((m: { role: string }) => m.role)).toEqual(['system', 'tool', 'assistant', 'user']);
  });

  it('reports signed-out and refusals by status only', async () => {
    const out = createWorkBuddyDriver({ fetchImpl: () => Promise.reject(new Error('x')), account: () => Promise.resolve(null) }).bind(provider);
    expect(await out.chat({ messages: [] })).toEqual({ error: { status: 401, message: 'no credential' } });
    const refused = createWorkBuddyDriver({
      fetchImpl: () => Promise.resolve(response(200, '{"code":10085,"msg":"bad ua"}', 'application/json')),
      account: () => Promise.resolve(account),
    }).bind(provider);
    expect(await refused.chat({ messages: [{ role: 'user', content: 'q' }] })).toEqual({ error: { status: 403, message: 'refused' } });
  });

  it("lists the cli agent's models, else the built-in list", async () => {
    const cfg = { code: 0, data: { agents: [{ name: 'cli', models: ['glm-5.3', 'auto'] }], models: [{ id: 'glm-5.3', name: 'GLM-5.3', reasoning: { supportedEfforts: ['high'] } }] } };
    const live = createWorkBuddyDriver({ fetchImpl: () => Promise.resolve(response(200, JSON.stringify(cfg), 'application/json')), account: () => Promise.resolve(account) }).bind(provider);
    expect(await live.listModels()).toEqual([{ id: 'glm-5.3', catalogName: 'GLM-5.3', reasoning: true }, { id: 'auto' }]);
    const down = createWorkBuddyDriver({ fetchImpl: () => Promise.resolve(response(500, '')), account: () => Promise.resolve(account) }).bind(provider);
    expect(await down.listModels()).toEqual([...WORKBUDDY_FALLBACK_MODELS]);
  });

  it('keeps one turn id across the steps of one user send', () => {
    const a = conversationHeaders({ messages: [{ role: 'user', content: 'do it' }] });
    const b = conversationHeaders({ messages: [{ role: 'user', content: 'do it' }, { role: 'assistant', content: '', tool_calls: [{}] }, { role: 'tool', content: 'r' }] });
    const c = conversationHeaders({ messages: [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] });
    expect(a['X-Conversation-Request-ID']).toBe(b['X-Conversation-Request-ID']);
    expect(c['X-Conversation-Request-ID']).not.toBe(a['X-Conversation-Request-ID']);
    expect(c['X-Conversation-ID']).toBe(a['X-Conversation-ID']);
    expect(a['X-Request-ID']).not.toBe(b['X-Request-ID']);
  });
});

describe('WorkBuddy auth', () => {
  it('renews a token about to end, in memory, and keeps the old one if renewal fails', async () => {
    let now = 1_000_000;
    const base = { ...account, expires: now + 30_000 };
    let ok = true;
    const auth = createWorkBuddyAuth({
      read: () => base,
      now: () => now,
      fetchImpl: () =>
        Promise.resolve(ok ? response(200, JSON.stringify({ code: 0, data: { accessToken: 'new', expiresIn: 3600 } }), 'application/json') : response(500, '')),
    });
    expect((await auth.current())!.access).toBe('new');
    expect((await auth.current())!.access).toBe('new'); // held, not renewed again
    now += 4_000_000;
    ok = false;
    expect((await auth.current())!.access).toBe('new');
  });
});
