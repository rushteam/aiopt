import { describe, expect, it } from 'vitest';
import type { ProxyFetchResponse } from '../../proxy/upstream';
import { createKiroAuth, kiroRegionOf, type KiroCredential, BUILDER_ID_PROFILE } from '../kiro/auth';
import { createKiroDriver, kiroModelsFrom, type KiroFetch } from '../kiro/driver';
import type { UpstreamEvent } from '../types';
import type { Provider } from '../../../shared/aiProviders';

function response(status: number, body: string | Uint8Array): ProxyFetchResponse {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    text: () => Promise.resolve(new TextDecoder().decode(bytes)),
  };
}

function frame(type: string, payload: unknown): Uint8Array {
  const enc = new TextEncoder();
  const hs: number[] = [];
  for (const [k, v] of Object.entries({ ':message-type': 'event', ':event-type': type })) {
    const kb = enc.encode(k);
    const vb = enc.encode(v);
    hs.push(kb.length, ...kb, 7, 0, vb.length, ...vb);
  }
  const body = enc.encode(JSON.stringify(payload));
  const out = new Uint8Array(16 + hs.length + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  new DataView(out.buffer).setUint32(4, hs.length);
  out.set(hs, 12);
  out.set(body, 12 + hs.length);
  return out;
}

const provider = { id: 'p', credentialMode: 'agent_import', agentImport: { agentId: 'kiro' } } as unknown as Provider;
const cred = (o: Partial<KiroCredential> = {}): KiroCredential => ({
  access: 'a1',
  refresh: 'r1',
  expires: 0,
  region: 'us-east-1',
  profile: 'arn:aws:codewhisperer:eu-central-1:1:profile/X',
  method: 'social',
  builderId: false,
  source: 'kiro-ide',
  ...o,
});

async function all(it: AsyncIterable<UpstreamEvent>): Promise<UpstreamEvent[]> {
  const out: UpstreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('Kiro auth', () => {
  it('takes the region from the profile', () => {
    expect(kiroRegionOf('arn:aws:codewhisperer:eu-central-1:1:profile/X', 'us-east-1')).toBe('eu-central-1');
    expect(kiroRegionOf('', 'eu-west-1')).toBe('eu-central-1');
    expect(kiroRegionOf('', 'us-west-2')).toBe('us-east-1');
  });

  it('uses the Builder ID profile and renews a social token about to end, in memory', async () => {
    const urls: string[] = [];
    let now = 1_000_000;
    const auth = createKiroAuth({
      read: () => cred({ profile: '', builderId: true, expires: now + 30_000 }),
      cliRefresh: null,
      now: () => now,
      fetchImpl: (url) => {
        urls.push(url);
        return Promise.resolve(response(200, JSON.stringify({ accessToken: 'a2', expiresIn: 3600 })));
      },
    });
    expect(await auth.current()).toEqual({ token: 'a2', profile: BUILDER_ID_PROFILE, region: 'us-east-1' });
    expect(urls).toEqual(['https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken']);
    now += 60_000;
    expect((await auth.current())?.token).toBe('a2');
    expect(urls).toHaveLength(1);
  });

  it('is signed out without a sign-in', async () => {
    const auth = createKiroAuth({ read: () => null, cliRefresh: null, fetchImpl: () => Promise.reject(new Error('x')) });
    expect(await auth.current()).toBeNull();
  });
});

describe('Kiro driver', () => {
  it('handles only Kiro imports', () => {
    const d = createKiroDriver({ fetchImpl: () => Promise.reject(new Error('x')), auth: { current: () => Promise.resolve(null) } });
    expect(d.handles(provider)).toBe(true);
    expect(d.handles({ ...provider, agentImport: { agentId: 'codex' } } as Provider)).toBe(false);
  });

  it('sends the conversation to the profile region and reads the event stream', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const fetchImpl: KiroFetch = (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return Promise.resolve(response(200, frame('assistantResponseEvent', { content: 'hi' })));
    };
    const account = { token: 'tok', profile: 'arn:aws:codewhisperer:eu-central-1:1:profile/X', region: 'eu-central-1' };
    const bound = createKiroDriver({ fetchImpl, auth: { current: () => Promise.resolve(account) } }).bind(provider);
    const r = await bound.chat({ model: 'auto', messages: [{ role: 'user', content: 'q' }] });
    if (!('events' in r)) throw new Error('expected events');
    const out = await all(r.events);
    expect(out[0]).toEqual({ text: 'hi' });
    expect(out[1]).toMatchObject({ stop: 'stop' });
    expect(calls[0]!.url).toBe('https://runtime.eu-central-1.kiro.dev/generateAssistantResponse');
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer tok', Accept: 'application/vnd.amazon.eventstream' });
    expect(JSON.parse(calls[0]!.body!).profileArn).toBe(account.profile);
  });

  it('renews once on a 403 and passes a second refusal on as 401', async () => {
    const stale: boolean[] = [];
    const fetchImpl: KiroFetch = () => Promise.resolve(response(403, '{"message":"bad"}'));
    const auth = {
      current: (_s?: AbortSignal, s = false) => {
        stale.push(s);
        return Promise.resolve({ token: 't', profile: '', region: 'us-east-1' });
      },
    };
    const r = await createKiroDriver({ fetchImpl, auth }).bind(provider).chat({ model: 'auto', messages: [] });
    expect(r).toEqual({ error: { status: 401, message: 'rejected' } });
    expect(stale).toEqual([false, true]);
  });

  it('maps a usage-limit refusal to 429', async () => {
    const fetchImpl: KiroFetch = () => Promise.resolve(response(400, '{"reason":"MONTHLY_REQUEST_COUNT"}'));
    const r = await createKiroDriver({ fetchImpl, auth: { current: () => Promise.resolve({ token: 't', profile: '', region: 'us-east-1' }) } })
      .bind(provider)
      .chat({ model: 'auto', messages: [] });
    expect(r).toEqual({ error: { status: 429, message: 'rejected' } });
  });

  it("lists Kiro's models, the default first", () => {
    const got = kiroModelsFrom({
      defaultModel: { modelId: 'auto' },
      models: [
        { modelId: 'claude-sonnet-4.5', modelName: 'Claude Sonnet 4.5', tokenLimits: { maxInputTokens: 200000 } },
        { modelId: 'auto', modelName: 'auto' },
      ],
    });
    expect(got.models).toEqual([
      { id: 'auto', catalogName: 'Auto', reasoning: true },
      { id: 'claude-sonnet-4.5', catalogName: 'Claude Sonnet 4.5', reasoning: true },
    ]);
    expect(got.windows.get('claude-sonnet-4.5')).toBe(200000);
  });
});
