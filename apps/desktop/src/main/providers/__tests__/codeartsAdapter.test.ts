import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCodeArtsAdapter } from '../adapters/codeartsAdapter';
import { codeartsSettingsRelative } from '../agentPaths';
import type { Provider } from '../../../shared/aiProviders';

const provider: Provider = {
  id: 'p1',
  name: 'TestProvider',
  apiFormats: ['openai', 'anthropic'],
  baseUrl: 'https://api.test.example/v1/',
  models: [{ id: 'test-model' }],
  createdAt: 0,
};

let home: string;
let prevHome: string | undefined;

const settingsFile = (): string => path.join(home, codeartsSettingsRelative());

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

describe('codearts adapter — writeLive', () => {
  it('appends aiopt customModels with stripped trailing slash', () => {
    createCodeArtsAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'test-model',
      apiKey: 'sk-test',
    });
    const config = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    expect(config.customModels).toHaveLength(1);
    expect(config.customModels[0]).toMatchObject({
      uid: 'aiopt-test-model',
      modelId: 'test-model',
      modelName: 'test-model',
      apiFormat: 'openai',
      modelUrl: 'https://api.test.example/v1', // trailing slash stripped; /v1 kept once
      apiKey: 'sk-test',
      enabled: true,
      sourceType: 'custom',
    });
  });

  it('appends /v1 when the provider base has none', () => {
    createCodeArtsAdapter().writeLive({
      provider: { ...provider, baseUrl: 'http://127.0.0.1:47821/tok' },
      apiFormat: 'openai',
      modelId: 'test-model',
      apiKey: 'tok',
    });
    const config = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    expect(config.customModels[0].modelUrl).toBe('http://127.0.0.1:47821/tok/v1');
  });

  it('preserves user custom models and maps anthropic format', () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({
        customModels: [
          {
            uid: 'user-1',
            modelId: 'mine',
            modelName: 'Mine',
            apiFormat: 'openai',
            modelUrl: 'https://other.example',
            apiKey: 'sk-user',
            enabled: true,
          },
        ],
      }),
    );
    createCodeArtsAdapter().writeLive({
      provider,
      apiFormat: 'anthropic',
      modelId: 'test-model',
      apiKey: null,
    });
    const config = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    expect(config.customModels).toHaveLength(2);
    expect(config.customModels[0].uid).toBe('user-1');
    expect(config.customModels[1]).toMatchObject({
      uid: 'aiopt-test-model',
      apiFormat: 'anthropic',
      apiKey: '',
    });
  });
});
