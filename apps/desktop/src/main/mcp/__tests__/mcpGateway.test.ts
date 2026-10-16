// The gateway end to end: a real loopback HTTP listener in front of `handle`, a real SDK
// client speaking Streamable HTTP to it, and in-memory upstream servers.
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpGateway, type McpGateway } from '../mcpGateway';
import type { GatewayServerSpec } from '../mcpStore';

/** An upstream MCP server with the given tools; `echo`-style calls return their name + args. */
function upstream(tools: string[]): { transport: InMemoryTransport; calls: string[] } {
  const calls: string[] = [];
  const server = new Server({ name: 'up', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((name) => ({ name, description: `tool ${name}`, inputSchema: { type: 'object' as const } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    calls.push(req.params.name);
    return { content: [{ type: 'text' as const, text: `${req.params.name}:${JSON.stringify(req.params.arguments ?? {})}` }] };
  });
  const [client, srv] = InMemoryTransport.createLinkedPair();
  void server.connect(srv);
  return { transport: client, calls };
}

const spec = (name: string, version = '1'): GatewayServerSpec => ({
  name,
  live: { transport: 'stdio', command: 'unused', args: [], env: {}, headers: {} },
  version,
});

interface Harness {
  gateway: McpGateway;
  url: string;
  http: HttpServer;
  connects: string[];
  state: { enabled: boolean; servers: GatewayServerSpec[] };
  ups: Map<string, ReturnType<typeof upstream>>;
}

let harness: Harness | null = null;
const clients: Client[] = [];

async function setup(servers: Record<string, string[]>): Promise<Harness> {
  const ups = new Map<string, ReturnType<typeof upstream>>();
  const connects: string[] = [];
  const state = { enabled: true, servers: Object.keys(servers).map((n) => spec(n)) };
  let port = -1;
  const gateway = createMcpGateway({
    enabled: () => state.enabled,
    servers: () => state.servers,
    port: () => port,
    childEnv: () => ({}),
    childCwd: () => '/',
    version: 'test',
    connectUpstream: (s) => {
      connects.push(s.name);
      const u = upstream(servers[s.name] ?? []);
      ups.set(s.name, u);
      return u.transport;
    },
  });
  const http = createServer((req, res) => {
    const path = (req.url ?? '/').replace(/^\/tok/, '');
    void gateway.handle(req, res, path);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  port = (http.address() as AddressInfo).port;
  harness = { gateway, url: `http://127.0.0.1:${port}/tok/mcp`, http, connects, state, ups };
  return harness;
}

async function connectClient(url: string): Promise<Client> {
  const client = new Client({ name: 'agent', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  if (harness) {
    await harness.gateway.stop();
    await new Promise<void>((resolve) => harness!.http.close(() => resolve()));
    harness = null;
  }
});

describe('MCP gateway', () => {
  it('aggregates every confirmed server with prefixed tool names', async () => {
    const h = await setup({ github: ['create_issue', 'search'], docs: ['search'] });
    const client = await connectClient(h.url);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['docs__search', 'github__create_issue', 'github__search']);
    expect(tools.find((t) => t.name === 'docs__search')?.description).toBe('[docs] tool search');
  });

  it('routes a call to the right upstream under its original name, with arguments', async () => {
    const h = await setup({ github: ['search'], docs: ['search'] });
    const client = await connectClient(h.url);
    await client.listTools();
    const r = await client.callTool({ name: 'docs__search', arguments: { q: 'x' } });
    expect(r.content).toEqual([{ type: 'text', text: 'search:{"q":"x"}' }]);
    expect(h.ups.get('docs')?.calls).toEqual(['search']);
    expect(h.ups.get('github')?.calls).toEqual([]);
  });

  it('starts an upstream once and reuses it across calls and sessions', async () => {
    const h = await setup({ a: ['t'] });
    const c1 = await connectClient(h.url);
    const c2 = await connectClient(h.url);
    await c1.callTool({ name: 'a__t' });
    await c2.callTool({ name: 'a__t' });
    expect(h.connects).toEqual(['a']);
    expect(h.gateway.status()).toEqual({ a: { status: 'running', tools: 1 } });
  });

  it('rejects an unknown tool', async () => {
    const h = await setup({ a: ['t'] });
    const client = await connectClient(h.url);
    await expect(client.callTool({ name: 'nope__t' })).rejects.toThrow(/unknown tool/);
  });

  it('restarts an upstream whose spec changed, and drops a removed one', async () => {
    const h = await setup({ a: ['t'], b: ['u'] });
    const client = await connectClient(h.url);
    await client.callTool({ name: 'a__t' });
    h.state.servers = [spec('a', '2')];
    h.gateway.refresh();
    await client.callTool({ name: 'a__t' });
    // The first call listed every server (a + b); only `a` is started again after its change.
    expect(h.connects).toEqual(['a', 'b', 'a']);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['a__t']);
  });

  it('answers nothing while off, and only on /mcp', async () => {
    const h = await setup({ a: ['t'] });
    h.state.enabled = false;
    const off = await fetch(h.url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(off.status).toBe(404);
    h.state.enabled = true;
    const wrong = await fetch(h.url.replace('/mcp', '/other'), { method: 'POST', body: '{}' });
    expect(wrong.status).toBe(404);
    expect(h.connects).toEqual([]);
  });

  it('refuses a foreign Host header (DNS rebinding)', async () => {
    const h = await setup({ a: ['t'] });
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        h.url,
        { method: 'POST', headers: { host: 'evil.example:80', 'content-type': 'application/json', accept: 'application/json, text/event-stream' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }));
    });
    expect(status).toBe(403);
  });

  it('rejects an unknown session id', async () => {
    const h = await setup({ a: ['t'] });
    const r = await fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.status).toBe(404);
  });

  it('stop() closes every upstream', async () => {
    const h = await setup({ a: ['t'] });
    const client = await connectClient(h.url);
    await client.callTool({ name: 'a__t' });
    await h.gateway.stop();
    expect(h.gateway.status()).toEqual({});
  });
});
