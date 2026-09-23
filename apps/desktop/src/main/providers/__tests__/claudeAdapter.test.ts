import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeAdapter } from '../adapters/claudeAdapter';
import { AGENT_BACKUP_SUFFIX } from '../fsutil';
import type { Provider } from '../../../shared/aiProviders';

const provider: Provider = {
  id: 'p1',
  name: 'Anthropic',
  apiFormat: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  models: [{ id: 'claude-opus-5' }],
  createdAt: 0,
};

let home: string;
let prevHome: string | undefined;

/** The sandbox path Claude Code reads (mirrors claudeSettingsPath under the override). */
function settingsFile(): string {
  return path.join(home, '.claude', 'settings.json');
}
function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-agent-home-'));
  prevHome = process.env.AIOPT_AGENT_HOME;
  process.env.AIOPT_AGENT_HOME = home; // sandbox — never touch the real ~/.claude
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.AIOPT_AGENT_HOME;
  else process.env.AIOPT_AGENT_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('claude adapter — detectInstalled', () => {
  it('is false when ~/.claude does not exist', () => {
    expect(createClaudeAdapter().detectInstalled()).toBe(false);
  });

  it('is true once ~/.claude exists', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    expect(createClaudeAdapter().detectInstalled()).toBe(true);
  });
});

describe('claude adapter — writeLive', () => {
  it('writes the three managed env keys into a fresh settings.json', () => {
    createClaudeAdapter().writeLive({ provider, modelId: 'claude-opus-5', apiKey: 'sk-secret' });
    const settings = readSettings();
    expect(settings).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_MODEL: 'claude-opus-5',
        ANTHROPIC_AUTH_TOKEN: 'sk-secret',
      },
    });
  });

  it('trailing newline is written', () => {
    createClaudeAdapter().writeLive({ provider, modelId: 'claude-opus-5', apiKey: 'sk' });
    expect(fs.readFileSync(settingsFile(), 'utf8').endsWith('}\n')).toBe(true);
  });

  it('merges into existing settings, preserving unrelated keys and env vars', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({
        theme: 'dark',
        env: { MY_OWN_VAR: 'keep-me', ANTHROPIC_MODEL: 'old-model' },
      }),
      'utf8',
    );
    createClaudeAdapter().writeLive({ provider, modelId: 'claude-opus-5', apiKey: 'sk' });
    const settings = readSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.env).toEqual({
      MY_OWN_VAR: 'keep-me',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_MODEL: 'claude-opus-5',
      ANTHROPIC_AUTH_TOKEN: 'sk',
    });
  });

  // Same assertions as the merge above, with a BOM on the front of the user's file. `JSON.parse`
  // THROWS on a leading U+FEFF, and readJsonObject fails open to `{}` — so without the strip,
  // binding an agent replaced the whole file with only AiOpt's keys and said nothing. A BOM is a
  // routine Windows artifact: PowerShell 5.1's `>`, `Out-File` and `Set-Content` all write one.
  it('merges into a settings file that carries a BOM, instead of discarding it', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      `\uFEFF${JSON.stringify({
        theme: 'dark',
        env: { MY_OWN_VAR: 'keep-me' },
      })}`,
      'utf8',
    );
    createClaudeAdapter().writeLive({ provider, modelId: 'claude-opus-5', apiKey: 'sk' });
    const settings = readSettings();
    expect(settings.theme).toBe('dark');
    expect((settings.env as Record<string, unknown>).MY_OWN_VAR).toBe('keep-me');
    // And the rewrite does not carry the BOM forward.
    expect(fs.readFileSync(settingsFile(), 'utf8').startsWith('\uFEFF')).toBe(false);
  });

  it('deletes a stale AUTH_TOKEN when no key is provided', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'old-token' } }),
      'utf8',
    );
    createClaudeAdapter().writeLive({ provider, modelId: 'claude-opus-5', apiKey: null });
    const env = readSettings().env as Record<string, unknown>;
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
  });

  it('takes a one-time pristine backup before the first rewrite', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const original = JSON.stringify({ env: { ANTHROPIC_MODEL: 'original' } });
    fs.writeFileSync(settingsFile(), original, 'utf8');

    const adapter = createClaudeAdapter();
    adapter.writeLive({ provider, modelId: 'claude-opus-5', apiKey: 'sk' });
    const backup = `${settingsFile()}${AGENT_BACKUP_SUFFIX}`;
    expect(fs.readFileSync(backup, 'utf8')).toBe(original);

    // A second write must NOT overwrite the pristine backup.
    adapter.writeLive({ provider, modelId: 'claude-sonnet', apiKey: 'sk2' });
    expect(fs.readFileSync(backup, 'utf8')).toBe(original);
  });

  it('recovers from a corrupt existing settings.json (fail-open merge)', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(settingsFile(), '{ this is not json', 'utf8');
    createClaudeAdapter().writeLive({ provider, modelId: 'claude-opus-5', apiKey: 'sk' });
    const env = readSettings().env as Record<string, unknown>;
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    // The corrupt original is preserved in the backup.
    expect(fs.readFileSync(`${settingsFile()}${AGENT_BACKUP_SUFFIX}`, 'utf8')).toBe('{ this is not json');
  });
});

describe('claude adapter — restoreDefault', () => {
  it('writes the pristine backup back and removes it (had a pre-AiOpt original)', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const original = JSON.stringify({ env: { ANTHROPIC_MODEL: 'original' } });
    fs.writeFileSync(settingsFile(), original, 'utf8');

    const adapter = createClaudeAdapter();
    adapter.writeLive({ provider, modelId: 'claude-opus-5', apiKey: 'sk' });
    expect(fs.existsSync(`${settingsFile()}${AGENT_BACKUP_SUFFIX}`)).toBe(true);

    adapter.restoreDefault();
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(original);
    // Ownership handed back: no backup left behind.
    expect(fs.existsSync(`${settingsFile()}${AGENT_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('deletes an AiOpt-created file that had no original to back up', () => {
    // No ~/.claude/settings.json existed → writeLive creates it, no backup taken.
    const adapter = createClaudeAdapter();
    adapter.writeLive({ provider, modelId: 'claude-opus-5', apiKey: 'sk' });
    expect(fs.existsSync(settingsFile())).toBe(true);
    expect(fs.existsSync(`${settingsFile()}${AGENT_BACKUP_SUFFIX}`)).toBe(false);

    adapter.restoreDefault();
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('is a no-op when neither the config nor a backup exists', () => {
    expect(() => createClaudeAdapter().restoreDefault()).not.toThrow();
    expect(fs.existsSync(settingsFile())).toBe(false);
  });
});
