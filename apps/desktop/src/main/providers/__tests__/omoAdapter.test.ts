import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOmoAdapter } from '../adapters/omoAdapter';
import type { Provider } from '../../../shared/aiProviders';

const provider: Provider = {
  id: 'p1',
  name: 'TestProvider',
  apiFormats: ['anthropic'],
  baseUrl: 'https://api.test.example',
  models: [{ id: 'test-model' }],
  createdAt: 0,
};

let home: string;
let prevHome: string | undefined;

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

describe('omo adapter — detectInstalled', () => {
  it('is false when ~/.omo does not exist', () => {
    expect(createOmoAdapter().detectInstalled()).toBe(false);
  });
  it('is true once ~/.omo exists', () => {
    fs.mkdirSync(path.join(home, '.omo'), { recursive: true });
    expect(createOmoAdapter().detectInstalled()).toBe(true);
  });
});

describe('omo adapter — writeLive', () => {
  it('writes all three files: auth, models, settings', () => {
    createOmoAdapter().writeLive({
      provider,
      apiFormat: 'anthropic',
      modelId: 'test-model',
      apiKey: 'sk-test',
    });
    const authFile = path.join(home, '.omo', 'agent', 'auth.json');
    const modelsFile = path.join(home, '.omo', 'agent', 'models.json');
    const settingsFile = path.join(home, '.omo', 'agent', 'settings.json');

    const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    expect(auth['aiopt-p1']).toEqual({ type: 'api_key', key: 'sk-test' });

    const models = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
    expect(models.providers['aiopt-p1'].baseUrl).toBe('https://api.test.example');
    expect(models.providers['aiopt-p1'].api).toBe('anthropic-messages');

    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    expect(settings.defaultProvider).toBe('aiopt-p1');
    expect(settings.defaultModel).toBe('test-model');
  });
});
