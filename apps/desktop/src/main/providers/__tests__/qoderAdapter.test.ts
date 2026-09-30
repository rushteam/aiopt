import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createQoderAdapter, createQoderCnAdapter } from '../adapters/qoderAdapter';
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

describe('qoder adapter — writeLive', () => {
  it('writes providers entry and model.name', () => {
    createQoderAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'test-model',
      apiKey: 'sk-test',
    });
    const config = JSON.parse(
      fs.readFileSync(path.join(home, '.qoder', 'settings.json'), 'utf8'),
    );
    expect(config.providers['aiopt-p1'].protocol).toBe('openai');
    expect(config.providers['aiopt-p1'].baseUrl).toBe('https://api.test.example/v1/v1');
    expect(config.providers['aiopt-p1'].apiKey).toBe('sk-test');
    expect(config.model.name).toBe('aiopt-p1/test-model');
  });
});

describe('qodercn adapter — writeLive', () => {
  it('writes to ~/.qoder-cn/settings.json', () => {
    createQoderCnAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'test-model',
      apiKey: 'sk-cn',
    });
    const config = JSON.parse(
      fs.readFileSync(path.join(home, '.qoder-cn', 'settings.json'), 'utf8'),
    );
    expect(config.providers['aiopt-p1'].apiKey).toBe('sk-cn');
    expect(config.model.name).toBe('aiopt-p1/test-model');
  });
});
