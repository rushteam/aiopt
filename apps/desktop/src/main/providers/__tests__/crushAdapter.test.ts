import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCrushAdapter } from '../adapters/crushAdapter';
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

const configFile = (): string => path.join(home, '.config', 'crush', 'crush.json');

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

describe('crush adapter — writeLive', () => {
  it('writes providers entry and sets models.large', () => {
    createCrushAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'test-model',
      apiKey: 'sk-test',
    });
    const config = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    expect(config.providers['aiopt-p1'].type).toBe('openai');
    expect(config.providers['aiopt-p1'].base_url).toBe('https://api.test.example/v1');
    expect(config.providers['aiopt-p1'].api_key).toBe('sk-test');
    expect(config.models.large).toEqual({ provider: 'aiopt-p1', model: 'test-model' });
  });

  it('omits api_key when null', () => {
    createCrushAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'test-model',
      apiKey: null,
    });
    const config = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    expect(config.providers['aiopt-p1'].api_key).toBeUndefined();
  });
});
