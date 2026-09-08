import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrokAdapter } from '../adapters/grokAdapter';
import { AGENT_BACKUP_SUFFIX } from '../fsutil';
import type { Provider } from '../../../shared/aiProviders';

const provider: Provider = {
  id: 'p1',
  name: 'xAI',
  apiFormat: 'openai',
  baseUrl: 'https://api.x.ai/v1',
  models: [{ id: 'grok-4' }],
  createdAt: 0,
};

let home: string;
let prevHome: string | undefined;

const configFile = (): string => path.join(home, '.grok', 'config.toml');

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

describe('grok adapter — detectInstalled', () => {
  it('is false when ~/.grok does not exist', () => {
    expect(createGrokAdapter().detectInstalled()).toBe(false);
  });
  it('is true once ~/.grok exists', () => {
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    expect(createGrokAdapter().detectInstalled()).toBe(true);
  });
});

describe('grok adapter — writeLive', () => {
  it('writes the exact config.toml with a default pointer and model profile', () => {
    createGrokAdapter().writeLive({ provider, modelId: 'grok-4', apiKey: 'sk-x' });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(
      [
        '[models]',
        'default = "grok-4"',
        '',
        '[model."grok-4"]',
        'model = "grok-4"',
        'base_url = "https://api.x.ai/v1"',
        'name = "xAI"',
        'api_key = "sk-x"',
        'api_backend = "responses"',
        'context_window = 500000',
        '',
      ].join('\n'),
    );
  });

  it('omits api_key when no key is provided', () => {
    createGrokAdapter().writeLive({ provider, modelId: 'grok-4', apiKey: null });
    expect(fs.readFileSync(configFile(), 'utf8')).not.toContain('api_key');
  });

  it('quotes a model id containing a dot in the profile header', () => {
    createGrokAdapter().writeLive({
      provider,
      modelId: 'grok-2.5',
      apiKey: 'sk',
    });
    expect(fs.readFileSync(configFile(), 'utf8')).toContain('[model."grok-2.5"]');
  });

  it('backs up a pristine config.toml once before rewriting', () => {
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    const original = 'old = true\n';
    fs.writeFileSync(configFile(), original, 'utf8');
    createGrokAdapter().writeLive({ provider, modelId: 'grok-4', apiKey: 'sk' });
    expect(fs.readFileSync(`${configFile()}${AGENT_BACKUP_SUFFIX}`, 'utf8')).toBe(original);
  });
});
