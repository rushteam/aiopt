import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKimiCodeAdapter } from '../adapters/kimicodeAdapter';
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

const configFile = (): string => path.join(home, '.kimi-code', 'config.toml');

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

describe('kimicode adapter — detectInstalled', () => {
  it('is false when ~/.kimi-code does not exist', () => {
    expect(createKimiCodeAdapter().detectInstalled()).toBe(false);
  });
  it('is true once ~/.kimi-code exists', () => {
    fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
    expect(createKimiCodeAdapter().detectInstalled()).toBe(true);
  });
});

describe('kimicode adapter — writeLive', () => {
  it('writes a TOML config with default_model, provider and model table', () => {
    createKimiCodeAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'test-model',
      apiKey: 'sk-test',
    });
    const content = fs.readFileSync(configFile(), 'utf8');
    expect(content).toContain('default_model = "aiopt/test-model"');
    expect(content).toContain('[providers.aiopt]');
    expect(content).toContain('api_key = "sk-test"');
    expect(content).toContain('api = "chat_completions"');
    expect(content).toContain('[models."aiopt/test-model"]');
    expect(content).toContain('provider = "aiopt"');
    expect(content).toContain('model = "test-model"');
  });

  it('omits api_key when null', () => {
    createKimiCodeAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'test-model',
      apiKey: null,
    });
    const content = fs.readFileSync(configFile(), 'utf8');
    expect(content).not.toContain('api_key');
  });

  it('backs up a pristine config.toml once', () => {
    fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
    const original = 'old = true\n';
    fs.writeFileSync(configFile(), original, 'utf8');
    createKimiCodeAdapter().writeLive({
      provider,
      apiFormat: 'openai',
      modelId: 'test-model',
      apiKey: 'sk',
    });
    expect(fs.readFileSync(`${configFile()}${AGENT_BACKUP_SUFFIX}`, 'utf8')).toBe(original);
  });
});
