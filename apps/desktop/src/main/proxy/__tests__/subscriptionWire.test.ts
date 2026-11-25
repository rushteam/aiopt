import { describe, expect, it } from 'vitest';
import { adaptSubscriptionRequest, CLAUDE_CODE_IDENTITY, subscriptionWireFor } from '../subscriptionWire';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

describe('subscriptionWireFor', () => {
  it('maps built-in OAuth kinds', () => {
    expect(subscriptionWireFor({ credentialMode: 'oauth', oauth: { kind: 'openai_codex' } })).toBe('codex');
    expect(subscriptionWireFor({ credentialMode: 'oauth', oauth: { kind: 'anthropic_claude' } })).toBe('claude');
    expect(subscriptionWireFor({ credentialMode: 'oauth', oauth: { kind: 'github_copilot' } })).toBe('copilot');
    expect(subscriptionWireFor({ credentialMode: 'oauth', oauth: { kind: 'generic_pkce' } })).toBeNull();
  });

  it('maps imported Codex / Claude sign-ins but not Copilot', () => {
    expect(subscriptionWireFor({ credentialMode: 'agent_import', agentImport: { agentId: 'codex' } })).toBe('codex');
    expect(subscriptionWireFor({ credentialMode: 'agent_import', agentImport: { agentId: 'claude' } })).toBe('claude');
    expect(subscriptionWireFor({ credentialMode: 'agent_import', agentImport: { agentId: 'copilot' } })).toBeNull();
  });

  it('ignores the oauth config of an API-key provider', () => {
    expect(subscriptionWireFor({ credentialMode: 'api_key', oauth: { kind: 'anthropic_claude' } })).toBeNull();
    expect(subscriptionWireFor(null)).toBeNull();
  });
});

describe('adaptSubscriptionRequest', () => {
  it('codex: account header, store:false, default instructions, no /v1', () => {
    const key = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' } });
    const req = { url: 'x', headers: { authorization: `Bearer ${key}` } as Record<string, string>, body: { stream: true } as Record<string, unknown> };
    const url = adaptSubscriptionRequest('codex', 'openai-responses', 'https://chatgpt.com/backend-api/codex/', key, req);
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(req.headers['chatgpt-account-id']).toBe('acc-1');
    expect(req.headers.originator).toBe('aiopt');
    expect(req.headers.accept).toBe('text/event-stream');
    expect(req.body.store).toBe(false);
    expect(req.body.instructions).toBe('You are a helpful assistant.');
  });

  it('codex: keeps caller instructions', () => {
    const req = { url: 'x', headers: {}, body: { instructions: 'mine' } as Record<string, unknown> };
    adaptSubscriptionRequest('codex', 'openai-responses', 'https://chatgpt.com/backend-api/codex', 'opaque', req);
    expect(req.body.instructions).toBe('mine');
    expect(req.headers).not.toHaveProperty('chatgpt-account-id');
  });

  it('claude: bearer auth, merged betas, identity prepended once', () => {
    const req = {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': 'k', 'anthropic-beta': 'foo,oauth-2025-04-20' } as Record<string, string>,
      body: { system: 'be brief' } as Record<string, unknown>,
    };
    const url = adaptSubscriptionRequest('claude', 'anthropic', 'https://api.anthropic.com', 'sk-ant-oat-1', req);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers).not.toHaveProperty('x-api-key');
    expect(req.headers.authorization).toBe('Bearer sk-ant-oat-1');
    expect(req.headers['anthropic-beta']).toBe('foo,oauth-2025-04-20,claude-code-20250219');
    expect(req.body.system).toEqual([
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: 'be brief' },
    ]);
    adaptSubscriptionRequest('claude', 'anthropic', 'https://api.anthropic.com', 'sk-ant-oat-1', req);
    expect(req.body.system).toHaveLength(2);
  });

  it('claude: array and absent system', () => {
    const arr = { url: 'u', headers: {}, body: { system: [{ type: 'text', text: 's' }] } as Record<string, unknown> };
    adaptSubscriptionRequest('claude', 'anthropic', 'b', 't', arr);
    expect((arr.body.system as unknown[]).length).toBe(2);
    const none = { url: 'u', headers: {}, body: {} as Record<string, unknown> };
    adaptSubscriptionRequest('claude', 'anthropic', 'b', 't', none);
    expect(none.body.system).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }]);
  });

  it('copilot: editor headers and the token-bound host', () => {
    const req = { url: 'x', headers: {} as Record<string, string>, body: {} };
    const tok = 'tid=1;exp=2;proxy-ep=proxy.individual.githubcopilot.com;st=x';
    expect(adaptSubscriptionRequest('copilot', 'openai', 'https://api.githubcopilot.com', tok, req)).toBe(
      'https://api.individual.githubcopilot.com/chat/completions',
    );
    expect(req.headers['Copilot-Integration-Id']).toBe('vscode-chat');
    expect(req.headers['Editor-Version']).toMatch(/^vscode\//);
  });

  it('copilot: an untrusted proxy-ep host falls back to the provider base', () => {
    const req = { url: 'x', headers: {}, body: {} };
    expect(
      adaptSubscriptionRequest('copilot', 'openai', 'https://api.githubcopilot.com/', 'proxy-ep=proxy.evil.example', req),
    ).toBe('https://api.githubcopilot.com/chat/completions');
  });

  it('leaves other formats untouched', () => {
    const req = { url: 'orig', headers: { 'x-api-key': 'k' } as Record<string, string>, body: {} };
    expect(adaptSubscriptionRequest('claude', 'openai', 'b', 't', req)).toBe('orig');
    expect(req.headers['x-api-key']).toBe('k');
  });
});
