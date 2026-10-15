import { describe, expect, it } from 'vitest';
import type { Provider } from '../../../shared/aiProviders';
import { createCursorDriver, isCursorProvider } from '../cursor/driver';
import type { CursorClient } from '../cursor/client';
import { fetchUpstreamModels, testUpstream } from '../providerOps';
import { createUpstreamRegistry, UpstreamError, type UpstreamDriver } from '../types';

const cursorProvider = {
  id: 'p1',
  name: 'Cursor (sign-in)',
  baseUrl: 'https://api2.cursor.sh',
  apiFormats: ['openai'],
  models: [],
  credentialMode: 'agent_import',
  agentImport: { agentId: 'cursor' },
} as unknown as Provider;
const plain = { ...cursorProvider, credentialMode: undefined, agentImport: undefined } as unknown as Provider;
const codex = { ...cursorProvider, agentImport: { agentId: 'codex' } } as unknown as Provider;

function client(models: CursorClient['models']): CursorClient {
  return { models, chat: () => Promise.resolve({ error: { status: 500, message: 'x' } }) };
}

describe('upstream registry', () => {
  it('binds the driver that handles a provider, else none', () => {
    const d = createCursorDriver({ client: client(() => Promise.resolve([])), token: () => Promise.resolve('t') });
    const reg = createUpstreamRegistry([d]);
    expect(reg.forProvider(cursorProvider)?.driverId).toBe('cursor');
    expect(reg.forProvider(plain)).toBeNull();
    expect(reg.forProvider(codex)).toBeNull();
    expect(reg.forProvider(undefined)).toBeNull();
    expect(isCursorProvider(cursorProvider)).toBe(true);
  });

  it('rejects duplicate driver ids', () => {
    const d: UpstreamDriver = { id: 'x', handles: () => false, bind: () => null as never };
    expect(() => createUpstreamRegistry([d, d])).toThrow('duplicate');
  });
});

describe('cursor driver', () => {
  it('maps the offered models and passes the token per call', async () => {
    const seen: string[] = [];
    const d = createCursorDriver({
      client: client((tok) => {
        seen.push(tok);
        return Promise.resolve([
          { id: 'auto', name: 'Auto', levels: {} },
          { id: 'claude-opus', name: 'Claude Opus', levels: { high: {} } },
        ] as never);
      }),
      token: () => Promise.resolve('tok-1'),
    });
    const res = await fetchUpstreamModels(d.bind(cursorProvider));
    expect(res.models).toEqual([
      { id: 'auto', catalogName: 'Auto' },
      { id: 'claude-opus', catalogName: 'Claude Opus', reasoning: true },
    ]);
    expect(seen).toEqual(['tok-1']);
  });

  it('reports signed out without calling Cursor', async () => {
    let called = false;
    const d = createCursorDriver({
      client: {
        models: () => {
          called = true;
          return Promise.resolve([]);
        },
        chat: () => {
          called = true;
          return Promise.resolve({ error: { status: 500, message: '' } });
        },
      },
      token: () => Promise.resolve(null),
    });
    const up = d.bind(cursorProvider);
    expect(await testUpstream(up)).toMatchObject({ ok: false, error: 'no_key' });
    expect(await up.chat({})).toEqual({ error: { status: 401, message: 'no credential' } });
    await expect(fetchUpstreamModels(up)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(called).toBe(false);
  });

  it('codes model-list failures for the test', async () => {
    const up = (status: number) =>
      createCursorDriver({
        client: client(() => Promise.reject(new UpstreamError({ status, message: 'raw' }))),
        token: () => Promise.resolve('t'),
      }).bind(cursorProvider);
    expect(await testUpstream(up(401))).toMatchObject({ error: 'unauthorized' });
    expect(await testUpstream(up(502))).toMatchObject({ error: 'unreachable' });
    expect(await testUpstream(up(429))).toMatchObject({ error: 'upstream' });
  });
});
