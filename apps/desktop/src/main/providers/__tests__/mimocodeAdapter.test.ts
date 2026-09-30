import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMimoCodeAdapter } from '../adapters/mimocodeAdapter';
import { AGENT_BACKUP_SUFFIX } from '../fsutil';
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

const configFile = (): string => path.join(home, '.config', 'mimocode', 'mimocode.json');

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

describe('mimocode adapter — detectInstalled', () => {
  it('is false when dir does not exist', () => {
    expect(createMimoCodeAdapter().detectInstalled()).toBe(false);
  });
  it('is true once dir exists', () => {
    fs.mkdirSync(path.join(home, '.config', 'mimocode'), { recursive: true });
    expect(createMimoCodeAdapter().detectInstalled()).toBe(true);
  });
});

describe('mimocode adapter — writeLive', () => {
  it('writes the config with an aiopt provider entry and model pointer', () => {
    createMimoCodeAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'test-model',
      apiKey: 'sk-test',
    });
    const config = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    expect(config.model).toBe('aiopt-p1/test-model');
    expect(config.provider['aiopt-p1']).toBeDefined();
    expect(config.provider['aiopt-p1'].options.baseURL).toBe('https://api.test.example/v1');
    expect(config.provider['aiopt-p1'].options.apiKey).toBe('sk-test');
  });

  it('preserves existing config keys', () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify({ mcp: { servers: {} } }, null, 2));
    createMimoCodeAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'test-model',
      apiKey: null,
    });
    const config = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    expect(config.mcp).toEqual({ servers: {} });
    expect(config.provider['aiopt-p1'].options.apiKey).toBeUndefined();
  });
});
