import { describe, expect, it } from 'vitest';
import type { ProvidersSnapshot } from '../../../shared/ipc-channels';
import { resolveWorkbenchModel, type ModelSources } from '../resolveModel';

function snapshot(proxied: boolean, bound = true): ProvidersSnapshot {
  return {
    providers: [
      {
        id: 'p1',
        name: 'Acme',
        apiFormat: 'anthropic',
        baseUrl: 'https://api.acme.test',
        models: [{ id: 'claude-x', alias: 'cx' }],
        createdAt: 1,
        hasKey: true,
      },
    ],
    agents: [
      {
        id: 'pi',
        name: 'pi',
        acceptedFormats: ['openai', 'anthropic'],
        mode: 'exclusive',
        installed: true,
        binding: bound ? { providerId: 'p1', modelId: 'claude-x' } : null,
        proxied,
      },
    ],
  } as unknown as ProvidersSnapshot;
}

function sources(snap: ProvidersSnapshot): ModelSources {
  return {
    snapshot: () => snap,
    endpointFor: () => ({ baseUrl: 'http://127.0.0.1:4000/t/abc', token: 'tok', modelId: 'cx', inboundFormat: 'anthropic' }),
    resolveUpstreamKey: () => 'sk-real',
  };
}

describe('resolveWorkbenchModel', () => {
  it('needs a pi binding', () => {
    expect(resolveWorkbenchModel(sources(snapshot(false, false)))).toBeNull();
  });

  it('goes direct with the provider key and the wire (alias) name', () => {
    expect(resolveWorkbenchModel(sources(snapshot(false)))).toEqual({
      view: { providerName: 'Acme', modelId: 'cx', proxied: false },
      baseUrl: 'https://api.acme.test',
      api: 'anthropic-messages',
      modelId: 'cx',
      key: 'sk-real',
    });
  });

  it('follows the proxy route with its token when pi is routed', () => {
    const got = resolveWorkbenchModel(sources(snapshot(true)));
    expect(got).toMatchObject({ baseUrl: 'http://127.0.0.1:4000/t/abc', key: 'tok', api: 'anthropic-messages' });
    expect(got?.view.proxied).toBe(true);
  });
});
