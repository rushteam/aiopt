import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFileProviderPersistence,
  createProviderStore,
  type ProviderPersistence,
  type ProvidersDocument,
} from '../providerStore';
import type { Provider } from '../../../shared/aiProviders';
import { decodeIpcError, isIpcError } from '../../../shared/ipc-errors';

/** In-memory persistence so the store logic tests without a filesystem. */
function memoryPersistence(seed: unknown = {}): ProviderPersistence & {
  readonly saved: ProvidersDocument | null;
} {
  let raw: unknown = seed;
  let last: ProvidersDocument | null = null;
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

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (isIpcError(err)) return err.code;
    if (err instanceof Error) return decodeIpcError(err.message).code;
  }
  throw new Error('expected the call to throw a coded error');
}

const sample: Provider = {
  id: 'p1',
  name: 'Anthropic',
  apiFormat: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  models: [{ id: 'claude-x', alias: 'cx' }],
  createdAt: 123,
};

describe('provider store — CRUD', () => {
  it('starts empty with no seed', () => {
    const store = createProviderStore(memoryPersistence());
    expect(store.listProviders()).toEqual([]);
    expect(store.getBindings()).toEqual({});
  });

  it('adds a provider and persists it', () => {
    const persistence = memoryPersistence();
    const store = createProviderStore(persistence);
    store.addProvider(sample);
    expect(store.getProvider('p1')).toEqual(sample);
    expect(persistence.saved?.providers).toEqual([sample]);
  });

  it('rejects a duplicate id with ALREADY_EXISTS', () => {
    const store = createProviderStore(memoryPersistence());
    store.addProvider(sample);
    expect(codeOf(() => store.addProvider(sample))).toBe('ALREADY_EXISTS');
  });

  it('replaceProvider throws NOT_FOUND for an unknown id', () => {
    const store = createProviderStore(memoryPersistence());
    expect(codeOf(() => store.replaceProvider(sample))).toBe('NOT_FOUND');
  });

  it('removeProvider also drops a binding that pointed at it', () => {
    const store = createProviderStore(memoryPersistence());
    store.addProvider(sample);
    store.setBinding('claude', { providerId: 'p1', modelId: 'claude-x' });
    expect(store.getBinding('claude')).toEqual({ providerId: 'p1', modelId: 'claude-x' });
    store.removeProvider('p1');
    expect(store.getProvider('p1')).toBeNull();
    expect(store.getBinding('claude')).toBeNull();
  });

  it('setBinding / clearBinding round-trip and persist', () => {
    const persistence = memoryPersistence();
    const store = createProviderStore(persistence);
    store.addProvider(sample);
    store.setBinding('claude', { providerId: 'p1', modelId: 'claude-x' });
    expect(persistence.saved?.bindings.claude).toEqual({ providerId: 'p1', modelId: 'claude-x' });
    store.clearBinding('claude');
    expect(store.getBinding('claude')).toBeNull();
    expect(persistence.saved?.bindings.claude).toBeUndefined();
  });
});

describe('provider store — drops leftover "official-" ids on load', () => {
  it('never keeps a provider whose id carries the reserved preset prefix', () => {
    // The pool is user-curated and mints fresh UUIDs; an "official-" id can only be a
    // record seeded by an older build. Loading drops it (self-migrating cleanup).
    const store = createProviderStore(
      memoryPersistence({
        providers: [
          { id: 'official-anthropic', name: 'Anthropic', apiFormat: 'anthropic', baseUrl: 'https://a', models: [{ id: 'a1' }], createdAt: 1 },
          sample,
        ],
      }),
    );
    expect(store.listProviders().map((p) => p.id)).toEqual(['p1']);
  });

  it('prunes a binding that pointed at a dropped official provider', () => {
    const store = createProviderStore(
      memoryPersistence({
        providers: [
          { id: 'official-anthropic', name: 'Anthropic', apiFormat: 'anthropic', baseUrl: 'https://a', models: [{ id: 'a1' }], createdAt: 1 },
        ],
        bindings: { claude: { providerId: 'official-anthropic', modelId: 'a1' } },
      }),
    );
    expect(store.listProviders()).toEqual([]);
    expect(store.getBinding('claude')).toBeNull();
  });
});

describe('provider store — load validation (fail-closed)', () => {
  it('drops a corrupt provider record but keeps valid ones', () => {
    const store = createProviderStore(
      memoryPersistence({
        providers: [
          sample,
          { id: '', name: 'no id', apiFormat: 'openai', baseUrl: 'x', models: [] }, // bad id
          { id: 'p2', name: 'bad format', apiFormat: 'nope', baseUrl: 'x', models: [] }, // bad format
          { id: 'p3', name: 'no base', apiFormat: 'openai', models: [] }, // missing baseUrl
        ],
      }),
    );
    expect(store.listProviders().map((p) => p.id)).toEqual(['p1']);
  });

  it('drops a duplicate id on load, keeping the first', () => {
    const store = createProviderStore(
      memoryPersistence({
        providers: [sample, { ...sample, name: 'Shadow' }],
      }),
    );
    expect(store.listProviders()).toHaveLength(1);
    expect(store.getProvider('p1')?.name).toBe('Anthropic');
  });

  it('filters corrupt models out of an otherwise-valid provider', () => {
    const store = createProviderStore(
      memoryPersistence({
        providers: [{ ...sample, models: [{ id: 'ok' }, { id: '' }, { nope: 1 }, 'bad'] }],
      }),
    );
    expect(store.getProvider('p1')?.models).toEqual([{ id: 'ok' }]);
  });

  it('drops a dangling binding whose provider does not exist', () => {
    const store = createProviderStore(
      memoryPersistence({
        providers: [sample],
        bindings: {
          claude: { providerId: 'p1', modelId: 'claude-x' }, // valid
          codex: { providerId: 'ghost', modelId: 'x' }, // dangling
        },
      }),
    );
    expect(store.getBinding('claude')).toEqual({ providerId: 'p1', modelId: 'claude-x' });
    expect(store.getBinding('codex')).toBeNull();
  });

  it('treats a non-object document as empty', () => {
    expect(createProviderStore(memoryPersistence(null)).listProviders()).toEqual([]);
    expect(createProviderStore(memoryPersistence([1, 2, 3])).listProviders()).toEqual([]);
    expect(createProviderStore(memoryPersistence('garbage')).listProviders()).toEqual([]);
  });
});

describe('file provider persistence', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-providers-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a document through a real file (versioned wrapper)', () => {
    const file = path.join(dir, 'providers.json');
    const store = createProviderStore(createFileProviderPersistence(file));
    store.addProvider(sample);
    store.setBinding('claude', { providerId: 'p1', modelId: 'claude-x' });

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(onDisk.version).toBe(2);

    const reopened = createProviderStore(createFileProviderPersistence(file));
    expect(reopened.getProvider('p1')).toEqual(sample);
    expect(reopened.getBinding('claude')).toEqual({ providerId: 'p1', modelId: 'claude-x' });
  });

  it('reads a missing file as an empty document', () => {
    const file = path.join(dir, 'nope.json');
    expect(createProviderStore(createFileProviderPersistence(file)).listProviders()).toEqual([]);
  });

  it('reads a corrupt file as an empty document rather than throwing', () => {
    const file = path.join(dir, 'providers.json');
    fs.writeFileSync(file, '{ not json', 'utf8');
    expect(createProviderStore(createFileProviderPersistence(file)).listProviders()).toEqual([]);
  });
});
