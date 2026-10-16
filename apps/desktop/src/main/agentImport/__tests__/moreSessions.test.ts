import { createCipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commandcodeSessionSnapshot,
  readCommandCodeAccessTokenSync,
} from '../commandcodeSession';
import {
  readZcodeAccessTokenSync,
  zcodeBaseUrl,
  zcodeDecrypt,
  zcodeSecret,
  zcodeSessionSnapshot,
  ZCODE_BIGMODEL_BASE,
  ZCODE_ZAI_BASE,
} from '../zcodeSession';
import { readWorkBuddyAccessTokenSync, workbuddySessionSnapshot } from '../workbuddySession';
import { workbuddyAuthFile } from '../../upstreams/workbuddy/auth';

function seal(key: Buffer, text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `enc:v1:${[iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.')}`;
}

describe('command code / zcode / workbuddy session readers', () => {
  let prev: string | undefined;
  let prevSecret: string | undefined;
  let home: string;
  const write = (rel: string, v: unknown) => {
    const f = path.join(home, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v));
  };

  beforeEach(() => {
    prev = process.env.AIOPT_AGENT_HOME;
    prevSecret = process.env.ZCODE_CREDENTIAL_SECRET;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-more-sessions-'));
    process.env.AIOPT_AGENT_HOME = home;
    process.env.ZCODE_CREDENTIAL_SECRET = 'test-secret';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AIOPT_AGENT_HOME;
    else process.env.AIOPT_AGENT_HOME = prev;
    if (prevSecret === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET;
    else process.env.ZCODE_CREDENTIAL_SECRET = prevSecret;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('command code: reads the CLI key and label; absent means signed out', () => {
    expect(commandcodeSessionSnapshot()).toEqual({ available: false, accountLabel: null });
    write('.commandcode/auth.json', { apiKey: ' user_abc ', userName: 'ada' });
    expect(readCommandCodeAccessTokenSync()).toBe('user_abc');
    expect(commandcodeSessionSnapshot()).toEqual({ available: true, accountLabel: 'ada' });
    write('.commandcode/auth.json', '{not json');
    expect(readCommandCodeAccessTokenSync()).toBeNull();
  });

  it('zcode: round-trips its sealed values and refuses a wrong key', () => {
    const key = zcodeSecret();
    expect(zcodeDecrypt(key, seal(key, 'hello'))).toBe('hello');
    expect(zcodeDecrypt(zcodeSecret({ ZCODE_CREDENTIAL_SECRET: 'other' }), seal(key, 'hello'))).toBeNull();
    expect(zcodeDecrypt(key, 'plain')).toBeNull();
  });

  it('zcode: imports a coding-plan key (BigModel picks its own endpoint)', () => {
    expect(zcodeSessionSnapshot().available).toBe(false);
    const key = zcodeSecret();
    write('.zcode/v2/credentials.json', {
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:u1:api-key': seal(key, 'abc.def'),
      'oauth:bigmodel:user_info': seal(key, JSON.stringify({ email: '1380000@phone.local' })),
    });
    expect(readZcodeAccessTokenSync()).toBe('abc.def');
    expect(zcodeBaseUrl()).toBe(ZCODE_BIGMODEL_BASE);
    expect(zcodeSessionSnapshot()).toEqual({ available: true, accountLabel: '1380000' });
    write('.zcode/v2/credentials.json', {
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:u1:api-key': seal(key, 'abc.def'),
      'account-provider:coding-plan:account:zai-individual-coding-plan:account:u2:api-key': seal(key, 'zai.key'),
    });
    expect(readZcodeAccessTokenSync()).toBe('zai.key');
    expect(zcodeBaseUrl()).toBe(ZCODE_ZAI_BASE);
  });

  it('zcode: falls back to config.json provider keys', () => {
    write('.zcode/v2/config.json', { provider: { 'builtin:zai-coding-plan': { options: { apiKey: 'k.1' } } } });
    expect(readZcodeAccessTokenSync()).toBe('k.1');
  });

  it('workbuddy: reads the desktop sign-in; a sealed token reads as signed out', () => {
    expect(workbuddySessionSnapshot().available).toBe(false);
    const rel = path.relative(home, workbuddyAuthFile());
    write(rel, { account: { uid: 'u1', nickname: 'Bo' }, auth: { accessToken: 'tok', expiresAt: 1 } });
    expect(readWorkBuddyAccessTokenSync()).toBe('tok');
    expect(workbuddySessionSnapshot()).toEqual({ available: true, accountLabel: 'Bo' });
    write(rel, { account: { uid: 'u1' }, auth: { accessToken: { $wbEncrypted: 1 } } });
    expect(workbuddySessionSnapshot().available).toBe(false);
  });
});
