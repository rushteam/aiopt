import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_FILES } from '../../providers/agentPaths';
import { codexSessionSnapshot, readCodexAccessTokenSync } from '../codexSession';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'aiopt-codex-import-'));
  process.env.AIOPT_AGENT_HOME = home;
});

afterEach(() => {
  delete process.env.AIOPT_AGENT_HOME;
});

function writeAuth(data: unknown): void {
  const dir = path.join(home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, AGENT_FILES.codex.auth), JSON.stringify(data), 'utf8');
}

describe('codex session import', () => {
  it('detects ChatGPT OAuth tokens', () => {
    writeAuth({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'at-secret', refresh_token: 'rt' },
    });
    expect(codexSessionSnapshot().available).toBe(true);
    expect(readCodexAccessTokenSync()).toBe('at-secret');
  });

  it('ignores apikey mode', () => {
    writeAuth({
      auth_mode: 'apikey',
      tokens: { access_token: 'at-secret' },
    });
    expect(codexSessionSnapshot().available).toBe(false);
  });
});
