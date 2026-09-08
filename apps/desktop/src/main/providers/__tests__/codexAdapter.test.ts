import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCodexAdapter } from '../adapters/codexAdapter';
import { AGENT_BACKUP_SUFFIX } from '../fsutil';
import type { Provider } from '../../../shared/aiProviders';

const provider: Provider = {
  id: 'p1',
  name: 'My OpenAI',
  apiFormat: 'openai',
  baseUrl: 'https://api.example.com/v1',
  models: [{ id: 'gpt-5-codex' }],
  createdAt: 0,
};

let home: string;
let prevHome: string | undefined;

const authFile = (): string => path.join(home, '.codex', 'auth.json');
const configFile = (): string => path.join(home, '.codex', 'config.toml');
const readAuth = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(authFile(), 'utf8')) as Record<string, unknown>;

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

describe('codex adapter — detectInstalled', () => {
  it('is false when ~/.codex does not exist', () => {
    expect(createCodexAdapter().detectInstalled()).toBe(false);
  });
  it('is true once ~/.codex exists', () => {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    expect(createCodexAdapter().detectInstalled()).toBe(true);
  });
});

describe('codex adapter — writeLive', () => {
  it('writes the API key into auth.json', () => {
    createCodexAdapter().writeLive({ provider, modelId: 'gpt-5-codex', apiKey: 'sk-secret' });
    expect(readAuth()).toEqual({ OPENAI_API_KEY: 'sk-secret' });
  });

  it('writes the exact custom-provider config.toml', () => {
    createCodexAdapter().writeLive({ provider, modelId: 'gpt-5-codex', apiKey: 'sk' });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(
      [
        'model_provider = "custom"',
        'model = "gpt-5-codex"',
        'model_reasoning_effort = "high"',
        'disable_response_storage = true',
        '',
        '[model_providers.custom]',
        'name = "My OpenAI"',
        'base_url = "https://api.example.com/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        '',
      ].join('\n'),
    );
  });

  it('merges auth.json, preserving an existing ChatGPT tokens block', () => {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(authFile(), JSON.stringify({ tokens: { access: 'keep' } }), 'utf8');
    createCodexAdapter().writeLive({ provider, modelId: 'gpt-5-codex', apiKey: 'sk' });
    expect(readAuth()).toEqual({ tokens: { access: 'keep' }, OPENAI_API_KEY: 'sk' });
  });

  it('drops a stale OPENAI_API_KEY when no key is provided', () => {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(authFile(), JSON.stringify({ OPENAI_API_KEY: 'old' }), 'utf8');
    createCodexAdapter().writeLive({ provider, modelId: 'gpt-5-codex', apiKey: null });
    expect(readAuth().OPENAI_API_KEY).toBeUndefined();
  });

  it('backs up a pristine config.toml once before rewriting', () => {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const original = 'model = "old"\n';
    fs.writeFileSync(configFile(), original, 'utf8');
    createCodexAdapter().writeLive({ provider, modelId: 'gpt-5-codex', apiKey: 'sk' });
    expect(fs.readFileSync(`${configFile()}${AGENT_BACKUP_SUFFIX}`, 'utf8')).toBe(original);
  });
});
