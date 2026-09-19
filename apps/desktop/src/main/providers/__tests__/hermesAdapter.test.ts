import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createHermesAdapter } from '../adapters/hermesAdapter';
import { AGENT_BACKUP_SUFFIX } from '../fsutil';
import type { Provider } from '../../../shared/aiProviders';

const provider: Provider = {
  id: 'p1',
  name: 'My Provider',
  apiFormat: 'openai',
  baseUrl: 'https://api.example.com/v1',
  models: [{ id: 'gpt-4o' }],
  createdAt: 0,
};

let home: string;
let prevHome: string | undefined;

const configFile = (): string => path.join(home, '.hermes', 'config.yaml');
const readRaw = (): string => fs.readFileSync(configFile(), 'utf8');
const readConfig = (): Record<string, unknown> => parse(readRaw()) as Record<string, unknown>;

type HermesProviderEntry = {
  name: string;
  base_url: string;
  api_mode: string;
  model: string;
  models: Record<string, unknown>;
  api_key?: string;
  [k: string]: unknown;
};
const customProviders = (): HermesProviderEntry[] =>
  (readConfig().custom_providers as HermesProviderEntry[]) ?? [];
const ourEntry = (): HermesProviderEntry =>
  customProviders().find((p) => p.name === 'aiopt-p1')!;

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

describe('hermes adapter — detectInstalled', () => {
  it('is false when ~/.hermes does not exist', () => {
    expect(createHermesAdapter().detectInstalled()).toBe(false);
  });
  it('is true once ~/.hermes exists', () => {
    fs.mkdirSync(path.join(home, '.hermes'), { recursive: true });
    expect(createHermesAdapter().detectInstalled()).toBe(true);
  });
});

describe('hermes adapter — writeLive', () => {
  it('writes a namespaced custom_providers entry and moves the startup pointer', () => {
    createHermesAdapter().writeLive({ provider, modelId: 'gpt-4o', apiKey: 'sk-o' });
    expect(readConfig()).toEqual({
      custom_providers: [
        {
          name: 'aiopt-p1',
          base_url: 'https://api.example.com/v1',
          api_mode: 'chat_completions',
          model: 'gpt-4o',
          models: { 'gpt-4o': {} },
          api_key: 'sk-o',
        },
      ],
      model: { default: 'gpt-4o', provider: 'aiopt-p1' },
    });
  });

  it('maps each accepted apiFormat to the right Hermes api_mode', () => {
    const adapter = createHermesAdapter();
    adapter.writeLive({ provider: { ...provider, apiFormat: 'anthropic' }, modelId: 'gpt-4o', apiKey: 'k' });
    expect(ourEntry().api_mode).toBe('anthropic_messages');
    adapter.writeLive({ provider: { ...provider, apiFormat: 'openai-responses' }, modelId: 'gpt-4o', apiKey: 'k' });
    expect(ourEntry().api_mode).toBe('codex_responses');
  });

  it('omits api_key when no key is stored', () => {
    createHermesAdapter().writeLive({ provider, modelId: 'gpt-4o', apiKey: null });
    expect('api_key' in ourEntry()).toBe(false);
  });

  it('lists models by outward wire name (alias when set)', () => {
    createHermesAdapter().writeLive({
      provider: { ...provider, models: [{ id: 'long-model-id', alias: 'gpt' }] },
      modelId: 'gpt',
      apiKey: 'k',
    });
    expect(ourEntry().models).toEqual({ gpt: {} });
    expect(ourEntry().model).toBe('gpt');
  });

  it('merges additively: comments, other providers, unrelated sections and Hermes-only fields survive', () => {
    fs.mkdirSync(path.join(home, '.hermes'), { recursive: true });
    fs.writeFileSync(
      configFile(),
      [
        '# my hermes config',
        'model:',
        '  default: old',
        '  provider: theirs',
        'agent:',
        '  max_turns: 50',
        'custom_providers:',
        '  - name: theirs',
        '    base_url: https://theirs/v1',
        '    api_key: sk-theirs',
        '  - name: aiopt-p1',
        '    base_url: https://stale/v1',
        '    api_mode: chat_completions',
        '    rate_limit_delay: 2', // Hermes-only field on our own entry
        'mcp_servers:',
        '  fs:',
        '    command: npx',
        '',
      ].join('\n'),
    );

    createHermesAdapter().writeLive({ provider, modelId: 'gpt-4o', apiKey: 'sk-new' });

    const raw = readRaw();
    expect(raw).toContain('# my hermes config'); // comment preserved
    const cfg = readConfig();
    // Other provider untouched.
    const theirs = customProviders().find((p) => p.name === 'theirs')!;
    expect(theirs).toEqual({ name: 'theirs', base_url: 'https://theirs/v1', api_key: 'sk-theirs' });
    // Our entry refreshed, its pre-existing Hermes-only field preserved.
    expect(ourEntry()).toEqual({
      name: 'aiopt-p1',
      base_url: 'https://api.example.com/v1',
      api_mode: 'chat_completions',
      model: 'gpt-4o',
      models: { 'gpt-4o': {} },
      rate_limit_delay: 2,
      api_key: 'sk-new',
    });
    // Startup pointer moved; unrelated sections intact.
    expect(cfg.model).toEqual({ default: 'gpt-4o', provider: 'aiopt-p1' });
    expect(cfg.agent).toEqual({ max_turns: 50 });
    expect(cfg.mcp_servers).toEqual({ fs: { command: 'npx' } });
    // No duplicate entry created.
    expect(customProviders().filter((p) => p.name === 'aiopt-p1')).toHaveLength(1);
  });
});

describe('hermes adapter — restoreDefault', () => {
  it('restores the pristine original and drops the backup', () => {
    fs.mkdirSync(path.join(home, '.hermes'), { recursive: true });
    fs.writeFileSync(configFile(), 'custom_providers:\n  - name: theirs\n');
    const adapter = createHermesAdapter();
    adapter.writeLive({ provider, modelId: 'gpt-4o', apiKey: 'sk' });
    adapter.restoreDefault();
    expect(readRaw()).toBe('custom_providers:\n  - name: theirs\n');
    expect(fs.existsSync(configFile() + AGENT_BACKUP_SUFFIX)).toBe(false);
  });

  it('removes an AiOpt-created file when there was no original', () => {
    const adapter = createHermesAdapter();
    adapter.writeLive({ provider, modelId: 'gpt-4o', apiKey: 'sk' });
    adapter.restoreDefault();
    expect(fs.existsSync(configFile())).toBe(false);
  });
});
