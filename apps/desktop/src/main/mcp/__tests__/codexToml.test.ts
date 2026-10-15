import { describe, expect, it } from 'vitest';
import {
  extractMcpBlocks,
  parseTableHeader,
  readCodexMcpServers,
  renderCodexMcpServer,
  replaceMcpBlocks,
  stripMcpBlocks,
} from '../codexToml';

const DOC = [
  'model = "gpt-5"',
  '',
  '[model_providers.custom]',
  'base_url = "https://x"',
  '',
  '[mcp_servers.fs]',
  'command = "npx"',
  'args = ["-y", "server-fs", "~/a b"]',
  'startup_timeout_sec = 30',
  '',
  '[mcp_servers.fs.env]',
  'TOKEN = "t1"',
  '',
  '[mcp_servers."docs.search"]',
  'url = "https://mcp.example.com/mcp"',
  'http_headers = { Authorization = "Bearer x" }',
  '',
  '[mcp_servers.fs.tools.read]',
  'approval = "never"',
  '',
  '[profiles.fast]',
  'model = "gpt-5-mini"',
  '',
].join('\n');

describe('parseTableHeader', () => {
  it('reads bare, quoted and literal segments', () => {
    expect(parseTableHeader('[a.b]')).toEqual(['a', 'b']);
    expect(parseTableHeader('[mcp_servers."x.y"] # c')).toEqual(['mcp_servers', 'x.y']);
    expect(parseTableHeader("[ a . 'q r' ]")).toEqual(['a', 'q r']);
  });
  it('rejects array-of-tables and garbage', () => {
    expect(parseTableHeader('[[a]]')).toBeNull();
    expect(parseTableHeader('[a..b]')).toBeNull();
    expect(parseTableHeader('x = [1]')).toBeNull();
  });
});

describe('codex MCP blocks', () => {
  it('reads servers, sub-tables, inline tables, and keeps unmodelled parts', () => {
    const m = readCodexMcpServers(DOC);
    expect([...m.keys()].sort()).toEqual(['docs.search', 'fs']);
    const fs = m.get('fs')!;
    expect(fs).toMatchObject({ command: 'npx', args: ['-y', 'server-fs', '~/a b'], env: { TOKEN: 't1' } });
    expect(fs.extraLines).toEqual(['startup_timeout_sec = 30']);
    expect(fs.extraBlocks).toEqual(['[mcp_servers.fs.tools.read]\napproval = "never"']);
    expect(m.get('docs.search')).toMatchObject({ url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } });
  });

  it('strip + extract split the document without losing a line', () => {
    const stripped = stripMcpBlocks(DOC);
    expect(stripped).toContain('[profiles.fast]');
    expect(stripped).toContain('[model_providers.custom]');
    expect(stripped).not.toContain('mcp_servers');
    expect(extractMcpBlocks(DOC)).not.toContain('profiles');
    expect(readCodexMcpServers(extractMcpBlocks(DOC)).size).toBe(2);
  });

  it('replaces only the named server', () => {
    const next = replaceMcpBlocks(DOC, new Set(['fs']), renderCodexMcpServer('fs', { command: 'node', args: [], env: {}, headers: {} }));
    const m = readCodexMcpServers(next);
    expect(m.get('fs')).toMatchObject({ command: 'node' });
    expect(m.get('docs.search')?.url).toBe('https://mcp.example.com/mcp');
    expect(next).toContain('[profiles.fast]');
    // Dropping with empty render removes every block of that server, sub-tables included.
    const dropped = replaceMcpBlocks(DOC, new Set(['fs']), '');
    expect(dropped).not.toContain('mcp_servers.fs');
  });

  it('render → read round-trips, quoting awkward names, keys and values', () => {
    const text = renderCodexMcpServer(
      'my.server',
      { command: 'C:\\tools\\x "y".exe', args: ['--a=1', 'ü'], env: { 'WEIRD KEY': 'v"\\', B: '2' }, headers: {} },
      { extraLines: ['enabled = true'], extraBlocks: [] },
    );
    const e = readCodexMcpServers(text).get('my.server')!;
    expect(e).toMatchObject({ command: 'C:\\tools\\x "y".exe', args: ['--a=1', 'ü'], env: { 'WEIRD KEY': 'v"\\', B: '2' } });
    expect(e.extraLines).toEqual(['enabled = true']);
  });
});
