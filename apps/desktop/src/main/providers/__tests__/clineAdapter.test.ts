import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClineAdapter } from '../adapters/clineAdapter';
import type { Provider } from '../../../shared/aiProviders';

const provider: Provider = {
  id: 'p1',
  name: 'TestProvider',
  apiFormats: ['openai'],
  baseUrl: 'https://api.test.example/v1',
  models: [{ id: 'test-model' }],
  createdAt: 0,
};

let home: string;
let prevHome: string | undefined;

const providersFile = (): string => path.join(home, '.cline', 'data', 'settings', 'providers.json');
const modelsFile = (): string => path.join(home, '.cline', 'data', 'settings', 'models.json');

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

describe('cline adapter — writeLive', () => {
  it('writes providers.json with openai-compatible slot and sets lastUsedProvider', () => {
    createClineAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'test-model',
      apiKey: 'sk-test',
    });
    const config = JSON.parse(fs.readFileSync(providersFile(), 'utf8'));
    expect(config.lastUsedProvider).toBe('openai-compatible');
    expect(config.providers['openai-compatible'].settings.model).toBe('test-model');
    expect(config.providers['openai-compatible'].settings.apiKey).toBe('sk-test');
    expect(config.providers['openai-compatible'].settings.baseUrl).toBe('https://api.test.example/v1/v1');
  });

  it('writes models.json with model entries', () => {
    createClineAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'test-model',
      apiKey: 'sk-test',
    });
    const models = JSON.parse(fs.readFileSync(modelsFile(), 'utf8'));
    expect(models.providers['openai-compatible'].models['test-model']).toBeDefined();
  });
});
