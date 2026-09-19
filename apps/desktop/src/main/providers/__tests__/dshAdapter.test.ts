import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createDshAdapter } from '../adapters/dshAdapter';
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

// The credential-reference name the adapter derives from the provider id.
const CRED_REF = 'AIOPT_P1_KEY';

let home: string;
let prevHome: string | undefined;

const settingsFile = (): string => path.join(home, '.dsh', 'settings.yaml');
const credsFile = (): string => path.join(home, '.dsh', '.credentials.yaml');
const readSettings = (): Record<string, unknown> =>
  parse(fs.readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>;
const readCreds = (): Record<string, unknown> =>
  parse(fs.readFileSync(credsFile(), 'utf8')) as Record<string, unknown>;

type DshProviderEntry = {
  displayName: string;
  api: string;
  baseURL: string;
  models: { id: string }[];
  apiKeyEnv?: string;
  [k: string]: unknown;
};
const providers = (): Record<string, DshProviderEntry> =>
  ((readSettings()['llm-pi-ai'] as Record<string, unknown>)?.providers as Record<string, DshProviderEntry>) ?? {};
const ourEntry = (): DshProviderEntry => providers()['aiopt-p1']!;
const refs = (): Record<string, string> => (readCreds().refs as Record<string, string>) ?? {};

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

describe('dsh adapter — detectInstalled', () => {
  it('is false when ~/.dsh does not exist', () => {
    expect(createDshAdapter().detectInstalled()).toBe(false);
  });
  it('is true once ~/.dsh exists', () => {
    fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
    expect(createDshAdapter().detectInstalled()).toBe(true);
  });
});

describe('dsh adapter — writeLive', () => {
  it('writes a namespaced provider (settings) and its secret (credentials), linked by apiKeyEnv', () => {
    createDshAdapter().writeLive({ provider, modelId: 'gpt-4o', apiKey: 'sk-o' });

    expect(readSettings()).toEqual({
      'llm-pi-ai': {
        providers: {
          'aiopt-p1': {
            displayName: 'My Provider',
            api: 'openai-completions',
            baseURL: 'https://api.example.com/v1',
            models: [{ id: 'gpt-4o' }],
            apiKeyEnv: CRED_REF,
          },
        },
      },
    });
    // The secret lives only in the credentials file, keyed by the reference name.
    expect(readCreds()).toEqual({ version: 1, refs: { [CRED_REF]: 'sk-o' } });
  });

  it('writes .credentials.yaml owner-only (0600) so dsh will load it', () => {
    createDshAdapter().writeLive({ provider, modelId: 'gpt-4o', apiKey: 'sk-o' });
    expect(fs.statSync(credsFile()).mode & 0o777).toBe(0o600);
  });

  it('maps each accepted apiFormat to the right dsh api', () => {
    const adapter = createDshAdapter();
    adapter.writeLive({ provider: { ...provider, apiFormat: 'anthropic' }, modelId: 'm', apiKey: 'k' });
    expect(ourEntry().api).toBe('anthropic-messages');
    adapter.writeLive({ provider: { ...provider, apiFormat: 'openai-responses' }, modelId: 'm', apiKey: 'k' });
    expect(ourEntry().api).toBe('openai-responses');
  });

  it('omits apiKeyEnv and the ref when no key is stored', () => {
    createDshAdapter().writeLive({ provider, modelId: 'gpt-4o', apiKey: null });
    expect('apiKeyEnv' in ourEntry()).toBe(false);
    expect(CRED_REF in refs()).toBe(false);
    expect(readCreds().version).toBe(1); // file is still a valid versioned store
  });

  it('lists models by outward wire name (alias when set)', () => {
    createDshAdapter().writeLive({
      provider: { ...provider, models: [{ id: 'long-model-id', alias: 'gpt' }] },
      modelId: 'gpt',
      apiKey: 'k',
    });
    expect(ourEntry().models).toEqual([{ id: 'gpt' }]);
  });

  it('merges additively: comments, other providers/namespaces and other refs survive', () => {
    fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      [
        '# my dsh config',
        'llm-pi-ai:',
        '  providers:',
        '    deepseek:',
        '      apiKeyEnv: DEEPSEEK_API_KEY',
        '      baseURL: https://api.deepseek.com',
        'agent:',
        '  max_turns: 50',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      credsFile(),
      ['version: 1', 'refs:', '  DEEPSEEK_API_KEY: sk-theirs', '  UNRELATED: keep-me', ''].join('\n'),
    );

    createDshAdapter().writeLive({ provider, modelId: 'gpt-4o', apiKey: 'sk-new' });

    expect(fs.readFileSync(settingsFile(), 'utf8')).toContain('# my dsh config'); // comment preserved
    // Other provider + unrelated namespace untouched.
    expect(providers().deepseek).toEqual({ apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' });
    expect(readSettings().agent).toEqual({ max_turns: 50 });
    // Our provider added alongside.
    expect(ourEntry().baseURL).toBe('https://api.example.com/v1');
    expect(ourEntry().apiKeyEnv).toBe(CRED_REF);
    // Other refs survive; ours added.
    expect(refs()).toEqual({ DEEPSEEK_API_KEY: 'sk-theirs', UNRELATED: 'keep-me', [CRED_REF]: 'sk-new' });
  });
});

describe('dsh adapter — restoreDefault', () => {
  it('restores pristine originals (at their original mode) and drops the backups', () => {
    fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
    fs.writeFileSync(settingsFile(), 'llm-pi-ai:\n  providers: {}\n');
    fs.writeFileSync(credsFile(), 'version: 1\nrefs:\n  KEEP: v\n', { mode: 0o600 });
    const adapter = createDshAdapter();
    adapter.writeLive({ provider, modelId: 'gpt-4o', apiKey: 'sk' });
    adapter.restoreDefault();
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('llm-pi-ai:\n  providers: {}\n');
    expect(fs.readFileSync(credsFile(), 'utf8')).toBe('version: 1\nrefs:\n  KEEP: v\n');
    expect(fs.statSync(credsFile()).mode & 0o777).toBe(0o600); // owner-only preserved on restore
    expect(fs.existsSync(settingsFile() + AGENT_BACKUP_SUFFIX)).toBe(false);
    expect(fs.existsSync(credsFile() + AGENT_BACKUP_SUFFIX)).toBe(false);
  });

  it('removes AiOpt-created files when there were no originals', () => {
    const adapter = createDshAdapter();
    adapter.writeLive({ provider, modelId: 'gpt-4o', apiKey: 'sk' });
    adapter.restoreDefault();
    expect(fs.existsSync(settingsFile())).toBe(false);
    expect(fs.existsSync(credsFile())).toBe(false);
  });
});
