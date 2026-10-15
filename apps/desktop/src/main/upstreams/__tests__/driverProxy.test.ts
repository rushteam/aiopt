import { afterEach, describe, expect, it } from 'vitest';
import { createTranslationProxy, type TranslationProxy } from '../../proxy/translationProxy';
import type { ProxyFetch } from '../../proxy/upstream';
import type { BoundUpstream, UpstreamChatResult, UpstreamEvent } from '../types';
import type { UsageEventInput } from '../../../shared/usageStats';

const failFetch: ProxyFetch = () => Promise.reject(new Error('the HTTP path must not be used'));

async function* events(...es: UpstreamEvent[]): AsyncGenerator<UpstreamEvent> {
  for (const e of es) yield e;
}

function fakeDriver(result: () => UpstreamChatResult): BoundUpstream & { bodies: unknown[] } {
  const bodies: unknown[] = [];
  return {
    bodies,
    driverId: 'fake',
    listModels: () => Promise.resolve([]),
    chat: (body) => {
      bodies.push(body);
      return Promise.resolve(result());
    },
  };
}

const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };

describe('translation proxy — upstream driver path', () => {
  const started: TranslationProxy[] = [];
  afterEach(async () => {
    for (const p of started.splice(0)) await p.stop();
  });

  async function start(driver: BoundUpstream, recorded: UsageEventInput[] = []): Promise<TranslationProxy> {
    const proxy = createTranslationProxy({
      fetchImpl: failFetch,
      getKey: () => null,
      upstreamFor: (id) => (id === 'cur' ? driver : null),
      recordUsage: (e) => recorded.push(e),
    });
    started.push(proxy);
    await proxy.start();
    return proxy;
  }

  it('answers an OpenAI chat request from the driver (non-streaming)', async () => {
    const recorded: UsageEventInput[] = [];
    const driver = fakeDriver(() => ({ events: events({ text: 'Hello' }, { stop: 'stop', usage }) }));
    const proxy = await start(driver, recorded);
    const { token } = proxy.registerRoute({
      agentId: 'opencode',
      providerId: 'cur',
      inboundFormat: 'openai',
      outboundFormat: 'openai',
      upstreamBaseUrl: 'https://upstream.invalid',
      modelId: 'auto',
    });
    const res = await fetch(`http://127.0.0.1:${proxy.getPort()}/${token}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]!.message.content).toBe('Hello');
    expect(recorded[0]).toMatchObject({ ok: true, inputTokens: 7, outputTokens: 3, streamed: false });
  });

  it('streams an Anthropic client through the existing translator', async () => {
    const driver = fakeDriver(() => ({ events: events({ text: 'Hi there' }, { stop: 'stop', usage }) }));
    const proxy = await start(driver);
    const { token } = proxy.registerRoute({
      agentId: 'claude',
      providerId: 'cur',
      inboundFormat: 'anthropic',
      outboundFormat: 'openai',
      upstreamBaseUrl: 'https://upstream.invalid',
      modelId: 'auto',
    });
    const res = await fetch(`http://127.0.0.1:${proxy.getPort()}/${token}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'x', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('Hi there');
    expect(text).toContain('event: message_stop');
    // the body the driver got is OpenAI Chat
    expect(driver.bodies[0]).toMatchObject({ messages: [{ role: 'user' }] });
  });

  it('keeps upstream error text away from the client', async () => {
    const driver = fakeDriver(() => ({ error: { status: 429, message: 'internal detail' } }));
    const proxy = await start(driver);
    const { token } = proxy.registerRoute({
      agentId: 'opencode',
      providerId: 'cur',
      inboundFormat: 'openai',
      outboundFormat: 'openai',
      upstreamBaseUrl: 'https://upstream.invalid',
      modelId: 'auto',
    });
    const res = await fetch(`http://127.0.0.1:${proxy.getPort()}/${token}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(429);
    expect(await res.text()).not.toContain('internal detail');
  });

  it('answers 401 when the driver has no credential', async () => {
    const driver = fakeDriver(() => ({ error: { status: 401, message: 'no credential' } }));
    const proxy = await start(driver);
    const { token } = proxy.registerRoute({
      agentId: 'opencode',
      providerId: 'cur',
      inboundFormat: 'openai',
      outboundFormat: 'openai',
      upstreamBaseUrl: 'https://upstream.invalid',
      modelId: 'auto',
    });
    const res = await fetch(`http://127.0.0.1:${proxy.getPort()}/${token}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'auto', messages: [] }),
    });
    expect(res.status).toBe(401);
  });
});

describe('translation proxy — driver route guard', () => {
  it('refuses a non-OpenAI outbound route to a driver without calling it', async () => {
    const driver = fakeDriver(() => ({ events: events() }));
    const proxy = createTranslationProxy({ fetchImpl: failFetch, getKey: () => null, upstreamFor: () => driver });
    await proxy.start();
    try {
      const { token } = proxy.registerRoute({
        agentId: 'claude',
        providerId: 'cur',
        inboundFormat: 'anthropic',
        outboundFormat: 'anthropic',
        upstreamBaseUrl: 'https://upstream.invalid',
        modelId: 'auto',
      });
      const res = await fetch(`http://127.0.0.1:${proxy.getPort()}/${token}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(502);
      expect(driver.bodies).toHaveLength(0);
    } finally {
      await proxy.stop();
    }
  });
});
