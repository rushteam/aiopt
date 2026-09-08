import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGeminiAdapter } from '../adapters/geminiAdapter';
import type { Provider } from '../../../shared/aiProviders';

const provider: Provider = {
  id: 'p1',
  name: 'Gemini',
  apiFormat: 'gemini',
  baseUrl: 'https://generativelanguage.example.com',
  models: [{ id: 'gemini-2.5-pro' }],
  createdAt: 0,
};

let home: string;
let prevHome: string | undefined;

const envFile = (): string => path.join(home, '.gemini', '.env');
const settingsFile = (): string => path.join(home, '.gemini', 'settings.json');
const readSettings = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>;

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

describe('gemini adapter — detectInstalled', () => {
  it('is false when ~/.gemini does not exist', () => {
    expect(createGeminiAdapter().detectInstalled()).toBe(false);
  });
  it('is true once ~/.gemini exists', () => {
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    expect(createGeminiAdapter().detectInstalled()).toBe(true);
  });
});

describe('gemini adapter — writeLive', () => {
  it('writes the three env vars alphabetically', () => {
    createGeminiAdapter().writeLive({ provider, modelId: 'gemini-2.5-pro', apiKey: 'sk-g' });
    expect(fs.readFileSync(envFile(), 'utf8')).toBe(
      ['GEMINI_API_KEY=sk-g', 'GEMINI_MODEL=gemini-2.5-pro', 'GOOGLE_GEMINI_BASE_URL=https://generativelanguage.example.com', ''].join(
        '\n',
      ),
    );
  });

  it('omits GEMINI_API_KEY when no key is provided', () => {
    createGeminiAdapter().writeLive({ provider, modelId: 'gemini-2.5-pro', apiKey: null });
    expect(fs.readFileSync(envFile(), 'utf8')).toBe(
      ['GEMINI_MODEL=gemini-2.5-pro', 'GOOGLE_GEMINI_BASE_URL=https://generativelanguage.example.com', ''].join('\n'),
    );
  });

  it('sets only security.auth.selectedType in settings.json, preserving the rest', () => {
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ theme: 'dark', security: { auth: { previous: 'x' } } }),
      'utf8',
    );
    createGeminiAdapter().writeLive({ provider, modelId: 'gemini-2.5-pro', apiKey: 'sk' });
    const settings = readSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.security).toEqual({
      auth: { previous: 'x', selectedType: 'gemini-api-key' },
    });
  });
});
