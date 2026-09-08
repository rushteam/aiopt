import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpenCodeAdapter } from '../adapters/opencodeAdapter';
import type { Provider } from '../../../shared/aiProviders';

const provider: Provider = {
  id: 'p1',
  name: 'My Provider',
  apiFormat: 'openai',
  baseUrl: 'https://api.example.com/v1',
  models: [{ id: 'gpt-4o' }],
  createdAt: 0,
};

let home: string;
let prevHome: string | undefined;

const configFile = (): string => path.join(home, '.config', 'opencode', 'opencode.json');
const readConfig = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(configFile(), 'utf8')) as Record<string, unknown>;

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

describe('opencode adapter — detectInstalled', () => {
  it('is false when ~/.config/opencode does not exist', () => {
    expect(createOpenCodeAdapter().detectInstalled()).toBe(false);
  });
  it('is true once ~/.config/opencode exists', () => {
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    expect(createOpenCodeAdapter().detectInstalled()).toBe(true);
  });
});

describe('opencode adapter — writeLive', () => {
  it('writes a namespaced provider entry, the model pointer and the schema', () => {
    createOpenCodeAdapter().writeLive({ provider, modelId: 'gpt-4o', apiKey: 'sk-o' });
    expect(readConfig()).toEqual({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        'aiopt-p1': {
          npm: '@ai-sdk/openai-compatible',
          name: 'My Provider',
          options: { baseURL: 'https://api.example.com/v1', apiKey: 'sk-o' },
          models: { 'gpt-4o': { name: 'gpt-4o' } },
        },
      },
      model: 'aiopt-p1/gpt-4o',
    });
  });

  it('uses the anthropic npm adapter for an anthropic-format provider', () => {
    createOpenCodeAdapter().writeLive({
      provider: { ...provider, apiFormat: 'anthropic' },
      modelId: 'gpt-4o',
      apiKey: 'sk',
    });
    const providers = readConfig().provider as Record<string, { npm: string }>;
    expect(providers['aiopt-p1']!.npm).toBe('@ai-sdk/anthropic');
  });

  it('merges additively: other providers, mcp and $schema are preserved', () => {
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(
      configFile(),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: { openai: { npm: '@ai-sdk/openai', name: 'Built-in' } },
        mcp: { some: 'server' },
      }),
      'utf8',
    );
    createOpenCodeAdapter().writeLive({ provider, modelId: 'gpt-4o', apiKey: 'sk' });
    const config = readConfig();
    const providers = config.provider as Record<string, unknown>;
    expect(providers.openai).toEqual({ npm: '@ai-sdk/openai', name: 'Built-in' });
    expect(providers['aiopt-p1']).toBeDefined();
    expect(config.mcp).toEqual({ some: 'server' });
  });

  it('omits apiKey from options when no key is provided', () => {
    createOpenCodeAdapter().writeLive({ provider, modelId: 'gpt-4o', apiKey: null });
    const providers = readConfig().provider as Record<string, { options: Record<string, unknown> }>;
    expect(providers['aiopt-p1']!.options).toEqual({ baseURL: 'https://api.example.com/v1' });
  });
});
