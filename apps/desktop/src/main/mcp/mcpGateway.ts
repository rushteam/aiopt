// The MCP gateway: ONE MCP endpoint (Streamable HTTP, on the translation proxy's loopback
// listener) that aggregates every library server the user put "through the gateway". AiOpt
// itself runs those servers (stdio children) or connects to them (http / sse), with their env
// / header values injected main-side from the secret store, and exposes their tools under a
// per-server prefix (`github__create_issue`).
//
// SECURITY (see docs/dev-rules/mcp-gateway.md):
//   • Opt-in: the `mcpGateway` preference gates every request; off = the path does not exist.
//   • Loopback only + an unguessable path token (+ Host check against DNS rebinding).
//   • Only servers the user confirmed natively for the gateway are served; an edited spec is
//     not served until confirmed again (mcpStore `setGateway` / `gatewayServers`).
//   • Upstream stderr is drained and discarded; tool arguments / results / values are never
//     logged. Logs carry server counts, statuses and error classes only.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../logger';
import {
  buildToolTable,
  type GatewayRoute,
  type McpGatewayUpstreamStatus,
  type McpGatewayUpstreamView,
} from '../../shared/mcpGateway';
import type { GatewayServerSpec } from './mcpStore';

const log = logger.child('mcpGateway');

/** Path under the gateway token: `http://127.0.0.1:<port>/<token>/mcp`. */
export const GATEWAY_PATH = '/mcp';

/** How long an upstream may take to start and answer `initialize` + `tools/list`. */
const START_TIMEOUT_MS = 30_000;
/** A tool call's own budget; progress notifications reset it. */
const CALL_TIMEOUT_MS = 120_000;
/** An upstream nobody called for this long is stopped (its tool list stays cached). */
const IDLE_STOP_MS = 10 * 60_000;
/** Cap on concurrent client sessions; the least recently used is closed past it. */
const MAX_SESSIONS = 32;

export interface McpGatewayDeps {
  /** Live: the `mcpGateway` preference. */
  enabled: () => boolean;
  /** Live: the confirmed servers to serve, values included (main-only). */
  servers: () => GatewayServerSpec[];
  /** Live: the proxy's loopback port (for the Host check), or -1. */
  port: () => number;
  /** Spawn environment for stdio children (PATH resolved for a GUI launch). */
  childEnv: () => Record<string, string>;
  /** Working directory for stdio children. */
  childCwd: () => string;
  /** AiOpt's version, sent as the gateway's / client's implementation version. */
  version: string;
  /** Test seam: build the transport to one upstream. */
  connectUpstream?: (spec: GatewayServerSpec) => Transport;
  /** Test seam: clock. */
  now?: () => number;
}

interface Upstream {
  spec: GatewayServerSpec;
  client: Client | null;
  starting: Promise<Client> | null;
  status: McpGatewayUpstreamStatus;
  tools: Tool[] | null;
  lastUsed: number;
}

interface Session {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

/** The error class only — never a message that could carry a path, argument or value. */
function errorClass(err: unknown): string {
  if (err instanceof McpError) return `mcp_${err.code}`;
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return err instanceof Error ? err.name : 'unknown';
}

export function createMcpGateway(deps: McpGatewayDeps) {
  const now = deps.now ?? Date.now;
  const upstreams = new Map<string, Upstream>();
  const sessions = new Map<string, Session>();
  let routes = new Map<string, GatewayRoute>();
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  const defaultConnect = (spec: GatewayServerSpec): Transport => {
    const live = spec.live;
    if (live.transport === 'stdio') {
      const t = new StdioClientTransport({
        command: live.command ?? '',
        args: live.args ?? [],
        // Our PATH first, then the server's own env (it may override PATH on purpose).
        env: { ...deps.childEnv(), ...live.env },
        cwd: deps.childCwd(),
        // Piped and drained: a server's stderr can echo tokens, so it never reaches a log.
        stderr: 'pipe',
      });
      return t;
    }
    const url = new URL(live.url ?? '');
    const requestInit: RequestInit = { headers: { ...live.headers } };
    return live.transport === 'sse'
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
  };
  const connect = deps.connectUpstream ?? defaultConnect;

  const ensureIdleTimer = (): void => {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      const cutoff = now() - IDLE_STOP_MS;
      for (const u of upstreams.values()) {
        if (u.client && u.lastUsed < cutoff) void stopUpstream(u, 'idle');
      }
    }, 60_000);
    idleTimer.unref?.();
  };

  const stopUpstream = async (u: Upstream, why: 'idle' | 'removed' | 'changed' | 'disabled'): Promise<void> => {
    const client = u.client;
    u.client = null;
    u.starting = null;
    if (u.status !== 'failed') u.status = 'idle';
    if (client) {
      log.info('gateway.upstream_stop', { why });
      await client.close().catch(() => undefined);
    }
  };

  const notifyToolsChanged = (): void => {
    for (const s of sessions.values()) void s.server.sendToolListChanged().catch(() => undefined);
  };

  /** Start (or reuse) one upstream's client. Concurrent callers share one start. */
  const startUpstream = (u: Upstream): Promise<Client> => {
    if (u.client) return Promise.resolve(u.client);
    if (u.starting) return u.starting;
    u.status = 'starting';
    const run = async (): Promise<Client> => {
      const client = new Client({ name: 'aiopt-gateway', version: deps.version }, { capabilities: {} });
      const transport = connect(u.spec);
      // Drain a piped stderr without reading it into anything.
      const stderr = (transport as Partial<StdioClientTransport>).stderr;
      stderr?.on?.('data', () => undefined);
      client.onclose = () => {
        if (u.client === client) {
          u.client = null;
          if (u.status === 'running') u.status = 'idle';
        }
      };
      client.onerror = () => undefined;
      await client.connect(transport, { timeout: START_TIMEOUT_MS });
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        try {
          u.tools = (await client.listTools(undefined, { timeout: START_TIMEOUT_MS })).tools;
        } catch {
          return;
        }
        rebuildRoutes();
        notifyToolsChanged();
      });
      const { tools } = await client.listTools(undefined, { timeout: START_TIMEOUT_MS });
      u.tools = tools;
      return client;
    };
    const started = run().then(
      (client) => {
        if (u.starting !== started) {
          // Stopped or replaced while starting: do not keep this one.
          void client.close().catch(() => undefined);
          throw new McpError(ErrorCode.ConnectionClosed, 'upstream was stopped');
        }
        u.client = client;
        u.starting = null;
        u.status = 'running';
        u.lastUsed = now();
        ensureIdleTimer();
        log.info('gateway.upstream_start', { tools: u.tools?.length ?? 0 });
        return client;
      },
      (err: unknown) => {
        if (u.starting === started) {
          u.starting = null;
          u.status = 'failed';
        }
        log.warn('gateway.upstream_failed', { error: errorClass(err) });
        throw err;
      },
    );
    u.starting = started;
    return started;
  };

  /** Make `upstreams` match the confirmed servers; a changed spec restarts that upstream. */
  const reconcile = (): void => {
    const want = deps.enabled() ? deps.servers() : [];
    const wanted = new Map(want.map((s) => [s.name, s]));
    let changed = false;
    for (const [name, u] of upstreams) {
      const next = wanted.get(name);
      if (!next) {
        upstreams.delete(name);
        void stopUpstream(u, deps.enabled() ? 'removed' : 'disabled');
        changed = true;
      } else if (next.version !== u.spec.version) {
        void stopUpstream(u, 'changed');
        u.spec = next;
        u.tools = null;
        u.status = 'idle';
        changed = true;
      }
    }
    for (const [name, spec] of wanted) {
      if (!upstreams.has(name)) {
        upstreams.set(name, { spec, client: null, starting: null, status: 'idle', tools: null, lastUsed: 0 });
        changed = true;
      }
    }
    if (changed) {
      rebuildRoutes();
      notifyToolsChanged();
    }
  };

  const rebuildRoutes = (): Tool[] => {
    const lists = [...upstreams.values()]
      .filter((u) => u.tools)
      .map((u) => ({ server: u.spec.name, tools: u.tools! }));
    const table = buildToolTable(lists);
    routes = table.routes;
    return table.tools;
  };

  const listTools = async (): Promise<Tool[]> => {
    reconcile();
    // Servers with no cached list are started now; failures are skipped, not fatal.
    await Promise.allSettled([...upstreams.values()].filter((u) => !u.tools).map((u) => startUpstream(u)));
    return rebuildRoutes();
  };

  const callTool = async (name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> => {
    reconcile();
    if (!routes.has(name)) await listTools();
    const route = routes.get(name);
    const u = route ? upstreams.get(route.server) : undefined;
    if (!route || !u) throw new McpError(ErrorCode.InvalidParams, 'unknown tool');
    u.lastUsed = now();
    let client: Client;
    try {
      client = await startUpstream(u);
    } catch {
      return { isError: true, content: [{ type: 'text', text: `MCP server "${route.server}" could not be started.` }] };
    }
    u.lastUsed = now();
    const result = await client.callTool(
      { name: route.tool, ...(args ? { arguments: args } : {}) },
      undefined,
      { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
    );
    u.lastUsed = now();
    return result as CallToolResult;
  };

  const newSession = (): Session => {
    const server = new Server(
      { name: 'aiopt', version: deps.version },
      {
        capabilities: { tools: { listChanged: true } },
        instructions: 'AiOpt MCP gateway. Tool names are prefixed with the MCP server they come from.',
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(req.params.name, req.params.arguments));
    const port = deps.port();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      onsessioninitialized: (id) => {
        sessions.set(id, session);
        evictSessions();
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    const session: Session = { server, transport, lastSeen: now() };
    transport.onerror = () => undefined;
    void server.connect(transport);
    return session;
  };

  const closeSession = (id: string, s: Session): void => {
    sessions.delete(id);
    void s.transport.close().catch(() => undefined);
    void s.server.close().catch(() => undefined);
  };

  const evictSessions = (): void => {
    while (sessions.size > MAX_SESSIONS) {
      let oldest: [string, Session] | null = null;
      for (const entry of sessions) if (!oldest || entry[1].lastSeen < oldest[1].lastSeen) oldest = entry;
      if (!oldest) break;
      closeSession(oldest[0], oldest[1]);
    }
  };

  const sendJsonRpcError = (res: ServerResponse, status: number, message: string): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
  };

  return {
    /**
     * Serve one HTTP request already matched to the gateway token. `rest` is the path after
     * the token. Never logs the body, headers or session id.
     */
    async handle(req: IncomingMessage, res: ServerResponse, rest: string): Promise<void> {
      if (!deps.enabled()) {
        sendJsonRpcError(res, 404, 'MCP gateway is off');
        return;
      }
      if ((rest.split('?')[0] ?? '') !== GATEWAY_PATH) {
        sendJsonRpcError(res, 404, 'not found');
        return;
      }
      const header = req.headers['mcp-session-id'];
      const id = Array.isArray(header) ? header[0] : header;
      let session = id ? sessions.get(id) : undefined;
      if (id && !session) {
        // Unknown / expired session: the client must re-initialize.
        sendJsonRpcError(res, 404, 'session not found');
        return;
      }
      if (!session) {
        if (req.method !== 'POST') {
          sendJsonRpcError(res, 400, 'no session');
          return;
        }
        session = newSession();
      }
      session.lastSeen = now();
      try {
        await session.transport.handleRequest(req, res);
      } catch (err) {
        log.warn('gateway.request_failed', { error: errorClass(err) });
        if (!res.headersSent) sendJsonRpcError(res, 500, 'gateway error');
      }
    },

    /** Re-read the confirmed servers (call after a library or preference change). */
    refresh(): void {
      reconcile();
    },

    /** Per served server: runtime status + last tool count. Counts and states only. */
    status(): Record<string, McpGatewayUpstreamView> {
      const out: Record<string, McpGatewayUpstreamView> = {};
      for (const [name, u] of upstreams) out[name] = { status: u.status, tools: u.tools ? u.tools.length : null };
      return out;
    },

    /** Close every session and stop every upstream (gateway off, or app quit). */
    async stop(): Promise<void> {
      if (idleTimer) clearInterval(idleTimer);
      idleTimer = null;
      for (const [id, s] of sessions) closeSession(id, s);
      const all = [...upstreams.values()];
      upstreams.clear();
      routes = new Map();
      await Promise.allSettled(all.map((u) => stopUpstream(u, 'disabled')));
    },
  };
}

export type McpGateway = ReturnType<typeof createMcpGateway>;
