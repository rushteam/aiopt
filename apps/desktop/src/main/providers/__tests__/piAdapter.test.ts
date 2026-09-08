import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPiAdapter } from '../adapters/piAdapter';
import type { Provider } from '../../../shared/aiProviders';

const provider: Provider = {
  id: 'p1',
  name: 'pi Anthropic',
  apiFormat: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  models: [{ id: 'claude-opus-5' }],
  createdAt: 0,
};

let home: string;
let prevHome: string | undefined;

const authFile = (): string => path.join(home, '.pi', 'agent', 'auth.json');
const modelsFile = (): string => path.join(home, '.pi', 'agent', 'models.json');
const settingsFile = (): string => path.join(home, '.pi', 'agent', 'settings.json');
const readJson = (f: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-agent-home-'));
  prevHome = process.env.AIOPT_AGENT_HOME;
  process.env.AIOPT_AGENT_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.AIOPT_AGENT_HOME;
  else process.env.AIOPT_AGENT_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('pi adapter — detectInstalled', () => {
  it('is false when ~/.pi does not exist', () => {
    expect(createPiAdapter().detectInstalled()).toBe(false);
  });
  it('is true once ~/.pi exists', () => {
    fs.mkdirSync(path.join(home, '.pi'), { recursive: true });
    expect(createPiAdapter().detectInstalled()).toBe(true);
  });
});

describe('pi adapter — writeLive', () => {
  it('writes the slug-keyed auth, models and settings binding', () => {
    createPiAdapter().writeLive({ provider, modelId: 'claude-opus-5', apiKey: 'sk-p' });
    expect(readJson(authFile())).toEqual({
      'aiopt-p1': { type: 'api_key', key: 'sk-p' },
    });
    expect(readJson(modelsFile())).toEqual({
      providers: {
        'aiopt-p1': {
          baseUrl: 'https://api.anthropic.com',
          api: 'anthropic-messages',
          models: [{ id: 'claude-opus-5' }],
        },
      },
    });
    expect(readJson(settingsFile())).toEqual({
      defaultProvider: 'aiopt-p1',
      defaultModel: 'claude-opus-5',
    });
  });

  it('maps an openai-format provider to pi openai-completions', () => {
    createPiAdapter().writeLive({
      provider: { ...provider, apiFormat: 'openai' },
      modelId: 'claude-opus-5',
      apiKey: 'sk',
    });
    const providers = readJson(modelsFile()).providers as Record<string, { api: string }>;
    expect(providers['aiopt-p1']!.api).toBe('openai-completions');
  });

  it('merges: preserves other pi providers and settings keys', () => {
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(authFile(), JSON.stringify({ other: { type: 'api_key', key: 'keep' } }), 'utf8');
    fs.writeFileSync(
      modelsFile(),
      JSON.stringify({ providers: { other: { baseUrl: 'https://x', api: 'openai-completions', models: [] } } }),
      'utf8',
    );
    fs.writeFileSync(settingsFile(), JSON.stringify({ theme: 'dark' }), 'utf8');

    createPiAdapter().writeLive({ provider, modelId: 'claude-opus-5', apiKey: 'sk' });

    expect((readJson(authFile()) as Record<string, unknown>).other).toEqual({
      type: 'api_key',
      key: 'keep',
    });
    const providers = readJson(modelsFile()).providers as Record<string, unknown>;
    expect(providers.other).toBeDefined();
    expect(providers['aiopt-p1']).toBeDefined();
    expect(readJson(settingsFile()).theme).toBe('dark');
  });

  it('drops the slug auth entry when no key is provided', () => {
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(authFile(), JSON.stringify({ 'aiopt-p1': { type: 'api_key', key: 'old' } }), 'utf8');
    createPiAdapter().writeLive({ provider, modelId: 'claude-opus-5', apiKey: null });
    expect(readJson(authFile())['aiopt-p1']).toBeUndefined();
  });

  it('lists a model by its alias (the outward wire name) when one is set', () => {
    createPiAdapter().writeLive({
      provider: { ...provider, models: [{ id: 'claude-opus-5', alias: 'opus' }] },
      modelId: 'opus',
      apiKey: 'sk',
    });
    const providers = readJson(modelsFile()).providers as Record<string, { models: unknown[] }>;
    expect(providers['aiopt-p1']!.models).toEqual([{ id: 'opus' }]);
  });
});
