import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFileProxyStatePersistence,
  createProxyStateStore,
  type PersistedRoute,
  type ProxyStatePersistence,
  type ProxyStateDoc,
} from '../proxyStore';
import type { RouteSpec } from '../router';

/** In-memory persistence so the store logic tests without a filesystem. */
function memoryPersistence(seed: unknown = {}): ProxyStatePersistence & {
  readonly saved: ProxyStateDoc | null;
} {
  let raw: unknown = seed;
  let last: ProxyStateDoc | null = null;
  return {
    load: () => raw,
    save: (doc) => {
      last = doc;
      raw = doc;
    },
    get saved() {
      return last;
    },
  };
}

function spec(overrides: Partial<RouteSpec> = {}): RouteSpec {
  return {
    agentId: 'claude',
    providerId: 'p1',
    inboundFormat: 'anthropic',
    outboundFormat: 'openai',
    upstreamBaseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-chat',
    ...overrides,
  };
}

function route(overrides: Partial<RouteSpec> = {}, token = 'tok-1'): PersistedRoute {
  return { token, spec: spec(overrides) };
}

describe('proxy state store — port', () => {
  it('starts with no port and round-trips a saved one', () => {
    const persistence = memoryPersistence();
    const store = createProxyStateStore(persistence);
    expect(store.loadPort()).toBeNull();
    store.savePort(51000);
    expect(store.loadPort()).toBe(51000);
    expect(persistence.saved?.port).toBe(51000);
  });

  it('drops an out-of-range or non-integer persisted port to null', () => {
    expect(createProxyStateStore(memoryPersistence({ port: 80 })).loadPort()).toBeNull();
    expect(createProxyStateStore(memoryPersistence({ port: 70000 })).loadPort()).toBeNull();
    expect(createProxyStateStore(memoryPersistence({ port: 5000.5 })).loadPort()).toBeNull();
    expect(createProxyStateStore(memoryPersistence({ port: 'nope' })).loadPort()).toBeNull();
    expect(createProxyStateStore(memoryPersistence({ port: 1024 })).loadPort()).toBe(1024);
    expect(createProxyStateStore(memoryPersistence({ port: 65535 })).loadPort()).toBe(65535);
  });
});

describe('proxy state store — routes', () => {
  it('round-trips routes and returns defensive copies', () => {
    const persistence = memoryPersistence();
    const store = createProxyStateStore(persistence);
    expect(store.loadRoutes()).toEqual([]);
    store.saveRoutes([route()]);
    expect(store.loadRoutes()).toEqual([route()]);
    // Mutating a returned copy must not corrupt the store's state.
    const copy = store.loadRoutes();
    copy[0]!.spec.modelId = 'mutated';
    expect(store.loadRoutes()[0]!.spec.modelId).toBe('deepseek-chat');
    expect(persistence.saved?.routes).toEqual([route()]);
  });

  it('drops a route with an empty token (fail-closed)', () => {
    const store = createProxyStateStore(memoryPersistence({ routes: [{ token: '', spec: spec() }, route()] }));
    expect(store.loadRoutes()).toEqual([route()]);
  });

  it('drops a route with an unknown agentId or bad format', () => {
    const store = createProxyStateStore(
      memoryPersistence({
        routes: [
          { token: 'a', spec: { ...spec(), agentId: 'nope' } },
          { token: 'b', spec: { ...spec(), inboundFormat: 'bogus' } },
          { token: 'c', spec: { ...spec(), upstreamBaseUrl: '' } },
          route({ agentId: 'codex' }, 'ok'),
        ],
      }),
    );
    expect(store.loadRoutes()).toEqual([route({ agentId: 'codex' }, 'ok')]);
  });

  it('drops a duplicate token or a second route for the same agent', () => {
    const store = createProxyStateStore(
      memoryPersistence({
        routes: [
          route({}, 'dup'),
          route({ modelId: 'other' }, 'dup'), // duplicate token
          route({ modelId: 'again' }, 'fresh'), // second route for claude
        ],
      }),
    );
    // First-wins: only the initial claude/dup route survives.
    expect(store.loadRoutes()).toEqual([route({}, 'dup')]);
  });

  it('treats a non-object / array document as empty', () => {
    expect(createProxyStateStore(memoryPersistence(null)).loadRoutes()).toEqual([]);
    expect(createProxyStateStore(memoryPersistence([1, 2])).loadPort()).toBeNull();
    expect(createProxyStateStore(memoryPersistence('garbage')).loadRoutes()).toEqual([]);
  });
});

describe('file proxy-state persistence', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-proxy-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips port + routes through a real file (versioned wrapper)', () => {
    const file = path.join(dir, 'proxy.json');
    const store = createProxyStateStore(createFileProxyStatePersistence(file));
    store.savePort(51234);
    store.saveRoutes([route()]);

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(onDisk.version).toBe(1);

    const reopened = createProxyStateStore(createFileProxyStatePersistence(file));
    expect(reopened.loadPort()).toBe(51234);
    expect(reopened.loadRoutes()).toEqual([route()]);
  });

  it('reads a missing file as an empty document', () => {
    const file = path.join(dir, 'nope.json');
    const store = createProxyStateStore(createFileProxyStatePersistence(file));
    expect(store.loadPort()).toBeNull();
    expect(store.loadRoutes()).toEqual([]);
  });

  it('reads a corrupt file as an empty document rather than throwing', () => {
    const file = path.join(dir, 'proxy.json');
    fs.writeFileSync(file, '{ not json', 'utf8');
    const store = createProxyStateStore(createFileProxyStatePersistence(file));
    expect(store.loadRoutes()).toEqual([]);
  });
});
