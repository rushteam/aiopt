import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicClaudeDriver, buildClaudeAuthorizeUrl, CLAUDE_CLIENT_ID } from '../drivers/anthropicClaude';
import {
  copilotBaseFromToken,
  exchangeCopilotToken,
  githubCopilotDriver,
  trustedVerificationUri,
} from '../drivers/githubCopilot';
import { buildCodexAuthorizeUrl, codexAccountId, openaiCodexDriver } from '../drivers/openaiCodex';
import { browserAuthorize, EXPIRY_MARGIN_MS } from '../drivers/subscriptionCommon';
import type { OAuthFetch } from '../drivers/types';
import { getOAuthDriver } from '../drivers/registry';

type Call = { url: string; init?: Parameters<OAuthFetch>[1] };

/** A fetch that answers each call from a queue of `[status, body]` replies, recording calls. */
function queuedFetch(replies: [number, unknown][]): { impl: OAuthFetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl: OAuthFetch = (url, init) => {
    calls.push({ url, init });
    const next = replies.shift();
    if (!next) return Promise.reject(new Error('unexpected fetch'));
    const [status, body] = next;
    return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
  };
  return { impl, calls };
}

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

/** Simulate the browser: follow the authorize URL's redirect_uri back with a code. */
function browserReturning(code: string, opts: { state?: string } = {}) {
  return vi.fn(async (authorizeUrl: string) => {
    const u = new URL(authorizeUrl);
    const redirect = new URL(u.searchParams.get('redirect_uri')!);
    redirect.hostname = '127.0.0.1';
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', opts.state ?? u.searchParams.get('state')!);
    void fetch(redirect).catch(() => undefined);
    return true;
  });
}

const blockers: Server[] = [];
afterEach(async () => {
  for (const s of blockers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

function holdPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      blockers.push(s);
      resolve((s.address() as { port: number }).port);
    });
  });
}

describe('registry', () => {
  it('serves a real driver for every subscription kind', () => {
    expect(getOAuthDriver('openai_codex')).toBe(openaiCodexDriver);
    expect(getOAuthDriver('anthropic_claude')).toBe(anthropicClaudeDriver);
    expect(getOAuthDriver('github_copilot')).toBe(githubCopilotDriver);
  });
});

describe('browserAuthorize', () => {
  it('fails loudly when a fixed vendor port is taken', async () => {
    const port = await holdPort();
    const open = vi.fn(async () => true);
    await expect(browserAuthorize(open, { port }, (u) => u, 's')).rejects.toThrow(/port .* is in use/);
    expect(open).not.toHaveBeenCalled();
  });

  it('falls back to an ephemeral port when the vendor allows it', async () => {
    const port = await holdPort();
    const open = vi.fn(async (url: string) => {
      const r = new URL(url);
      expect(Number(r.port)).not.toBe(port);
      void fetch(`${url}?code=abc&state=s`).catch(() => undefined);
      return true;
    });
    const res = await browserAuthorize(open, { port, fallbackToEphemeral: true }, (u) => u, 's');
    expect(res.code).toBe('abc');
  });

  it('rejects a state mismatch', async () => {
    const open = vi.fn(async (url: string) => {
      void fetch(`${url}?code=abc&state=other`).catch(() => undefined);
      return true;
    });
    await expect(browserAuthorize(open, { port: 0 }, (u) => u, 's')).rejects.toThrow(/state mismatch/);
  });

  it('stops when the browser cannot be opened', async () => {
    await expect(browserAuthorize(async () => false, { port: 0 }, (u) => u, 's')).rejects.toThrow(/browser/);
  });
});

describe('ChatGPT (Codex) driver', () => {
  it('builds the Codex authorize URL', () => {
    const u = new URL(buildCodexAuthorizeUrl('http://localhost:1455/auth/callback', 'st', 'ch'));
    expect(u.origin + u.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(u.searchParams.get('code_challenge')).toBe('ch');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('originator')).toBe('aiopt');
    expect(u.searchParams.get('scope')).toContain('offline_access');
  });

  it('reads the account id claim', () => {
    expect(codexAccountId(jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'a1' } }))).toBe('a1');
    expect(codexAccountId(jwt({}))).toBeNull();
    expect(codexAccountId('not-a-jwt')).toBeNull();
  });

  it('refresh keeps the old refresh token only when the reply omits one', async () => {
    const { impl, calls } = queuedFetch([
      [200, { access_token: 'a2', expires_in: 3600 }],
      [200, { access_token: 'a3', refresh_token: 'r3', expires_in: 3600 }],
    ]);
    const input = { config: { kind: 'openai_codex' as const }, refreshToken: 'r1' };
    expect((await openaiCodexDriver.refresh!(input, impl)).refreshToken).toBe('r1');
    expect((await openaiCodexDriver.refresh!(input, impl)).refreshToken).toBe('r3');
    expect(calls[0]!.url).toBe('https://auth.openai.com/oauth/token');
    expect(new URLSearchParams(calls[0]!.init!.body).get('grant_type')).toBe('refresh_token');
  });

  it('never surfaces the token endpoint error body', async () => {
    const { impl } = queuedFetch([[400, { error: 'invalid_grant', echoed: 'r1-secret' }]]);
    const err = await openaiCodexDriver
      .refresh!({ config: { kind: 'openai_codex' }, refreshToken: 'r1-secret' }, impl)
      .catch((e: Error) => e);
    expect(String(err)).toMatch(/refresh failed/);
    expect(String(err)).not.toContain('secret');
  });
});

describe('Claude driver', () => {
  it('builds the Claude authorize URL', () => {
    const u = new URL(buildClaudeAuthorizeUrl('http://localhost:53692/callback', 'st', 'ch'));
    expect(u.origin + u.pathname).toBe('https://claude.ai/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe(CLAUDE_CLIENT_ID);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('runs the browser login and exchanges the code as JSON', async () => {
    const { impl, calls } = queuedFetch([
      [200, { access_token: 'sk-ant-oat-1', refresh_token: 'r1', expires_in: 3600, account: { email_address: 'a@b.c' } }],
    ]);
    const open = browserReturning('the-code');
    const res = await anthropicClaudeDriver.runLogin!({ fetchImpl: impl, openExternal: open });
    expect(res.accountLabel).toBe('a@b.c');
    expect(res.tokens.accessToken).toBe('sk-ant-oat-1');
    expect(res.tokens.refreshToken).toBe('r1');
    const body = JSON.parse(calls[0]!.init!.body!);
    expect(calls[0]!.url).toBe('https://platform.claude.com/v1/oauth/token');
    expect(body).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', client_id: CLAUDE_CLIENT_ID });
    expect(body.code_verifier).toEqual(expect.any(String));
    expect(body.redirect_uri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
  });

  it('requires a refresh token', async () => {
    const { impl } = queuedFetch([[200, { access_token: 'sk-ant-oat-1', expires_in: 3600 }]]);
    await expect(
      anthropicClaudeDriver.runLogin!({ fetchImpl: impl, openExternal: browserReturning('c') }),
    ).rejects.toThrow(/no refresh token/);
  });
});

describe('Copilot driver', () => {
  const device = {
    device_code: 'dev',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    interval: 1,
    expires_in: 900,
  };

  it('only trusts GitHub device pages', () => {
    expect(trustedVerificationUri('https://github.com/login/device')).toBe('https://github.com/login/device');
    expect(trustedVerificationUri('https://evil.example/login/device')).toBeNull();
    expect(trustedVerificationUri('http://github.com/login/device')).toBeNull();
    expect(trustedVerificationUri(42)).toBeNull();
  });

  it('derives the API base only from githubcopilot.com hosts', () => {
    expect(copilotBaseFromToken('tid=1;proxy-ep=proxy.business.githubcopilot.com;x=1')).toBe(
      'https://api.business.githubcopilot.com',
    );
    expect(copilotBaseFromToken('proxy-ep=proxy.evil.com')).toBeNull();
    expect(copilotBaseFromToken('proxy-ep=evil.com/x.githubcopilot.com')).toBeNull();
    expect(copilotBaseFromToken('tid=1')).toBeNull();
  });

  it('runs the device flow: dialog, browser, polling with slow_down, then the Copilot exchange', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 1800;
    const { impl, calls } = queuedFetch([
      [200, device],
      [200, { error: 'authorization_pending' }],
      [200, { error: 'slow_down', interval: 7 }],
      [200, { access_token: 'gho_x' }],
      [200, { token: 'tid=1;proxy-ep=proxy.individual.githubcopilot.com', expires_at: expiresAt }],
      [200, { login: 'octo' }],
    ]);
    const sleeps: number[] = [];
    const showDeviceCode = vi.fn(async () => true);
    const openExternal = vi.fn(async () => true);
    const res = await githubCopilotDriver.runLogin!({
      fetchImpl: impl,
      openExternal,
      showDeviceCode,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(showDeviceCode).toHaveBeenCalledWith({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
    expect(openExternal).toHaveBeenCalledWith('https://github.com/login/device');
    expect(sleeps).toEqual([1000, 1000, 7000]);
    expect(res.accountLabel).toBe('octo');
    expect(res.tokens.refreshToken).toBe('gho_x');
    expect(res.tokens.expiresAt).toBe(expiresAt * 1000 - EXPIRY_MARGIN_MS);
    expect(calls[4]!.init!.headers!.authorization).toBe('Bearer gho_x');
  });

  it('stops when the user cancels the code dialog', async () => {
    const { impl } = queuedFetch([[200, device]]);
    const openExternal = vi.fn(async () => true);
    await expect(
      githubCopilotDriver.runLogin!({ fetchImpl: impl, openExternal, showDeviceCode: async () => false }),
    ).rejects.toThrow(/cancelled/);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('refuses an untrusted verification URI before showing anything', async () => {
    const { impl } = queuedFetch([[200, { ...device, verification_uri: 'https://evil.example/device' }]]);
    const showDeviceCode = vi.fn(async () => true);
    await expect(
      githubCopilotDriver.runLogin!({ fetchImpl: impl, openExternal: async () => true, showDeviceCode }),
    ).rejects.toThrow(/device code/);
    expect(showDeviceCode).not.toHaveBeenCalled();
  });

  it('is unavailable without a device-code dialog', async () => {
    const { impl } = queuedFetch([]);
    await expect(githubCopilotDriver.runLogin!({ fetchImpl: impl, openExternal: async () => true })).rejects.toThrow(
      /unavailable/,
    );
  });

  it('maps a missing subscription to a clear error', async () => {
    const { impl } = queuedFetch([[403, { message: 'no' }]]);
    await expect(exchangeCopilotToken(impl, 'gho_x')).rejects.toThrow(/no active Copilot subscription/);
  });

  it('refresh re-exchanges the GitHub token', async () => {
    const { impl, calls } = queuedFetch([[200, { token: 't2', expires_at: 2_000_000_000 }]]);
    const b = await githubCopilotDriver.refresh!({ config: { kind: 'github_copilot' }, refreshToken: 'gho_x' }, impl);
    expect(b).toEqual({ accessToken: 't2', refreshToken: 'gho_x', expiresAt: 2_000_000_000_000 - EXPIRY_MARGIN_MS });
    expect(calls[0]!.url).toBe('https://api.github.com/copilot_internal/v2/token');
  });
});
