import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpConfigPath, readAgentMcp, sameMcpServer, writeAgentMcp, type LiveMcpServer } from '../agentMcpConfig';
import { restoreKeepingCodexMcp, restoreKeepingJsonMcp, withCodexMcpBlocks } from '../preserveMcp';
import { createCodexAdapter } from '../../providers/adapters/codexAdapter';
import { createGeminiAdapter } from '../../providers/adapters/geminiAdapter';
import { AGENT_BACKUP_SUFFIX } from '../../providers/fsutil';
import type { Provider } from '../../../shared/aiProviders';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-mcp-home-'));
  prevHome = process.env.AIOPT_AGENT_HOME;
  process.env.AIOPT_AGENT_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.AIOPT_AGENT_HOME;
  else process.env.AIOPT_AGENT_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const put = (o: Record<string, LiveMcpServer>) => new Map(Object.entries(o));
const stdio: LiveMcpServer = { transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { K: 'v' }, headers: {} };
const http: LiveMcpServer = { transport: 'http', url: 'https://m.example/mcp', env: {}, headers: { Authorization: 'Bearer z' } };
const sse: LiveMcpServer = { transport: 'sse', url: 'https://m.example/sse', env: {}, headers: {} };

function writeFile(rel: string, text: string): string {
  const f = path.join(home, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}
const json = (f: string): Record<string, unknown> => JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;

describe('agent MCP config — Claude ~/.claude.json', () => {
  it('touches only mcpServers and keeps every other key', () => {
    const f = writeFile('.claude.json', JSON.stringify({ numStartups: 7, projects: { '/a': { x: 1 } }, mcpServers: { keep: { command: 'k' } } }));
    writeAgentMcp('claude', put({ fs: stdio, web: http, ev: sse }), new Set());
    const doc = json(f);
    expect(doc.numStartups).toBe(7);
    expect(doc.projects).toEqual({ '/a': { x: 1 } });
    expect(doc.mcpServers).toEqual({
      keep: { command: 'k' },
      fs: { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { K: 'v' } },
      web: { type: 'http', url: 'https://m.example/mcp', headers: { Authorization: 'Bearer z' } },
      ev: { type: 'sse', url: 'https://m.example/sse' },
    });
    const r = readAgentMcp('claude');
    expect(r.state).toBe('ok');
    if (r.state === 'ok') {
      expect(sameMcpServer(r.servers.get('fs')!, stdio)).toBe(true);
      expect(sameMcpServer(r.servers.get('web')!, http)).toBe(true);
      expect(r.servers.get('ev')!.transport).toBe('sse');
    }
    writeAgentMcp('claude', new Map(), new Set(['fs', 'web', 'ev']));
    expect(json(f).mcpServers).toEqual({ keep: { command: 'k' } });
  });

  it('an unparseable file is unreadable and is never written', () => {
    const f = writeFile('.claude.json', '{ "numStartups": 7, broken');
    expect(readAgentMcp('claude').state).toBe('unreadable');
    expect(() => writeAgentMcp('claude', put({ fs: stdio }), new Set())).toThrow();
    expect(fs.readFileSync(f, 'utf8')).toBe('{ "numStartups": 7, broken');
    writeFile('.claude.json', JSON.stringify({ mcpServers: [] }));
    expect(readAgentMcp('claude').state).toBe('unreadable');
  });

  it('keeps unmodelled entry fields on rewrite, and ignores them when comparing', () => {
    const f = writeFile('.claude.json', JSON.stringify({ mcpServers: { fs: { type: 'stdio', command: 'old', args: [], env: {}, timeout: 5 } } }));
    writeAgentMcp('claude', put({ fs: stdio }), new Set());
    expect((json(f).mcpServers as Record<string, Record<string, unknown>>).fs).toMatchObject({ command: 'npx', timeout: 5 });
  });

  it.skipIf(process.platform === 'win32')('creates a new file owner-only, and keeps an existing mode', () => {
    writeAgentMcp('claude', put({ fs: stdio }), new Set());
    expect(fs.statSync(mcpConfigPath('claude')).mode & 0o777).toBe(0o600);
    const g = writeFile('.gemini/settings.json', '{}');
    fs.chmodSync(g, 0o640);
    writeAgentMcp('gemini', put({ fs: stdio }), new Set());
    expect(fs.statSync(g).mode & 0o777).toBe(0o640);
  });
});

describe('agent MCP config — Gemini and Codex', () => {
  it('Gemini uses httpUrl for http and url for sse', () => {
    const f = writeFile('.gemini/settings.json', JSON.stringify({ theme: 'dark' }));
    writeAgentMcp('gemini', put({ web: http, ev: sse }), new Set());
    expect(json(f)).toEqual({
      theme: 'dark',
      mcpServers: {
        web: { httpUrl: 'https://m.example/mcp', headers: { Authorization: 'Bearer z' } },
        ev: { url: 'https://m.example/sse' },
      },
    });
    const r = readAgentMcp('gemini');
    expect(r.state === 'ok' && r.servers.get('web')?.transport).toBe('http');
    expect(r.state === 'ok' && r.servers.get('ev')?.transport).toBe('sse');
  });

  it('Codex rewrites only its own blocks and keeps the rest of config.toml', () => {
    const f = writeFile('.codex/config.toml', 'model = "m"\n\n[mcp_servers.other]\ncommand = "o"\n');
    writeAgentMcp('codex', put({ fs: stdio, web: http }), new Set());
    const text = fs.readFileSync(f, 'utf8');
    expect(text.startsWith('model = "m"')).toBe(true);
    const r = readAgentMcp('codex');
    expect(r.state).toBe('ok');
    if (r.state === 'ok') {
      expect([...r.servers.keys()].sort()).toEqual(['fs', 'other', 'web']);
      expect(sameMcpServer(r.servers.get('fs')!, stdio)).toBe(true);
      expect(sameMcpServer(r.servers.get('web')!, http)).toBe(true);
    }
    writeAgentMcp('codex', new Map(), new Set(['fs']));
    const after = readAgentMcp('codex');
    expect(after.state === 'ok' && [...after.servers.keys()].sort()).toEqual(['other', 'web']);
  });

  it('a missing file reads as ok and empty', () => {
    expect(readAgentMcp('gemini')).toMatchObject({ state: 'ok', exists: false });
  });
});

const provider: Provider = {
  id: 'p1',
  name: 'P',
  apiFormats: ['openai-responses', 'gemini'],
  baseUrl: 'https://api.example.com/v1',
  models: [{ id: 'm1' }],
  createdAt: 0,
};

describe('binding adapters keep MCP servers', () => {
  it('Codex writeLive carries [mcp_servers.*] over, restore keeps the current ones', () => {
    const f = writeFile('.codex/config.toml', 'model = "orig"\n\n[mcp_servers.old]\ncommand = "o"\n');
    const adapter = createCodexAdapter();
    // Added after the backup: a later MCP write must survive both apply and restore.
    adapter.writeLive({ provider, apiFormat: 'openai-responses', modelId: 'm1', apiKey: 'sk' });
    expect(fs.existsSync(f + AGENT_BACKUP_SUFFIX)).toBe(true);
    let r = readAgentMcp('codex');
    expect(r.state === 'ok' && [...r.servers.keys()]).toEqual(['old']);
    writeAgentMcp('codex', put({ fs: stdio }), new Set(['old']));
    adapter.writeLive({ provider, apiFormat: 'openai-responses', modelId: 'm1', apiKey: 'sk' });
    r = readAgentMcp('codex');
    expect(r.state === 'ok' && [...r.servers.keys()]).toEqual(['fs']);
    adapter.restoreDefault();
    const text = fs.readFileSync(f, 'utf8');
    expect(text).toContain('model = "orig"');
    r = readAgentMcp('codex');
    expect(r.state === 'ok' && [...r.servers.keys()]).toEqual(['fs']);
  });

  it('Gemini restore keeps the current mcpServers', () => {
    const f = writeFile('.gemini/settings.json', JSON.stringify({ theme: 'orig' }));
    const adapter = createGeminiAdapter();
    adapter.writeLive({ provider, apiFormat: 'gemini', modelId: 'm1', apiKey: 'k' });
    writeAgentMcp('gemini', put({ web: http }), new Set());
    adapter.writeLive({ provider, apiFormat: 'gemini', modelId: 'm1', apiKey: 'k' });
    expect(Object.keys(json(f).mcpServers as object)).toEqual(['web']);
    adapter.restoreDefault();
    expect(json(f)).toMatchObject({ theme: 'orig', mcpServers: { web: { httpUrl: 'https://m.example/mcp' } } });
  });
});

describe('preserveMcp helpers', () => {
  it('withCodexMcpBlocks appends the current blocks', () => {
    const f = writeFile('.codex/config.toml', 'x = 1\n[mcp_servers.a]\ncommand = "a"\n');
    expect(withCodexMcpBlocks(f, 'y = 2\n')).toBe('y = 2\n\n[mcp_servers.a]\ncommand = "a"\n');
    fs.writeFileSync(f, 'x = 1\n');
    expect(withCodexMcpBlocks(f, 'y = 2\n')).toBe('y = 2\n');
  });

  it('restore without current MCP drops the restored copy’s stale servers', () => {
    const f = writeFile('.codex/config.toml', 'x = 1\n');
    restoreKeepingCodexMcp(f, () => fs.writeFileSync(f, 'x = 0\n[mcp_servers.stale]\ncommand = "s"\n'));
    expect(fs.readFileSync(f, 'utf8')).not.toContain('stale');
    const g = writeFile('.gemini/settings.json', JSON.stringify({ a: 1 }));
    restoreKeepingJsonMcp(g, () => fs.writeFileSync(g, JSON.stringify({ a: 0, mcpServers: { stale: {} } })));
    expect(json(g)).toEqual({ a: 0 });
  });

  it('restore that deletes the file (no backup) does not recreate an empty one', () => {
    const f = writeFile('.codex/config.toml', 'x = 1\n');
    restoreKeepingCodexMcp(f, () => fs.rmSync(f));
    expect(fs.existsSync(f)).toBe(false);
  });
});
