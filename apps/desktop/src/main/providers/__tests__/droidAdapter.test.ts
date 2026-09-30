import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDroidAdapter } from '../adapters/droidAdapter';
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

const settingsFile = (): string => path.join(home, '.factory', 'settings.json');

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

describe('droid adapter — writeLive', () => {
  it('appends customModels and sets sessionDefaultSettings.model', () => {
    createDroidAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'test-model',
      apiKey: 'sk-test',
    });
    const config = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    expect(config.sessionDefaultSettings.model).toBe('custom:aiopt/test-model');
    expect(config.customModels).toHaveLength(1);
    expect(config.customModels[0].id).toBe('custom:aiopt/test-model');
    expect(config.customModels[0].baseUrl).toBe('https://api.test.example/v1');
    expect(config.customModels[0].apiKey).toBe('sk-test');
  });

  it('preserves user custom models', () => {
    fs.mkdirSync(path.join(home, '.factory'), { recursive: true });
    const existing = {
      customModels: [{ id: 'user-model', model: 'my-model', baseUrl: 'https://other.example' }],
    };
    fs.writeFileSync(settingsFile(), JSON.stringify(existing));
    createDroidAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'test-model',
      apiKey: null,
    });
    const config = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    expect(config.customModels).toHaveLength(2);
    expect(config.customModels[0].id).toBe('user-model');
    expect(config.customModels[1].id).toBe('custom:aiopt/test-model');
  });
});
