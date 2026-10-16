// MCP gateway — pure naming / routing helpers shared by main and tests.
//
// The gateway aggregates every library server the user put "through the gateway" behind ONE
// MCP endpoint (`aiopt` in each agent's config). Each upstream tool is exposed under a
// per-server prefix so two servers can both have a `search` tool. See
// docs/dev-rules/mcp-gateway.md.

/** The single server name AiOpt writes into an agent config for the gateway. Reserved. */
export const GATEWAY_SERVER_NAME = 'aiopt';

/** Separator between the server and tool part of an exposed tool name. */
export const GATEWAY_TOOL_SEP = '__';

/**
 * Longest exposed tool name. Claude Code / Codex prefix a tool as `mcp__aiopt__<name>`, and
 * model APIs cap tool names at 64 characters, so the gateway keeps its part to 64 - 12.
 */
export const GATEWAY_TOOL_NAME_MAX = 52;

/** Exposed tool names use the strictest common charset of the agents' model APIs. */
const UNSAFE_TOOL_CHARS = /[^A-Za-z0-9_-]/g;

/** Small stable hash (FNV-1a, base36) to keep truncated names unique and deterministic. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0').slice(0, 7);
}

/** The exposed name for one upstream tool: `<server>__<tool>`, sanitized and capped. */
export function gatewayToolName(server: string, tool: string): string {
  const raw = `${server}${GATEWAY_TOOL_SEP}${tool}`;
  const safe = raw.replace(UNSAFE_TOOL_CHARS, '_');
  if (safe.length <= GATEWAY_TOOL_NAME_MAX && safe === raw) return safe;
  // Sanitizing or cutting could make two names collide; a hash of the ORIGINAL keeps them apart.
  const suffix = `_${shortHash(raw)}`;
  return safe.length + suffix.length <= GATEWAY_TOOL_NAME_MAX
    ? `${safe}${suffix}`
    : `${safe.slice(0, GATEWAY_TOOL_NAME_MAX - suffix.length)}${suffix}`;
}

/** One upstream tool, as the gateway sees it (only the fields it forwards). */
export interface UpstreamTool {
  name: string;
  description?: string;
  [extra: string]: unknown;
}

/** What one exposed name routes to. */
export interface GatewayRoute {
  server: string;
  tool: string;
}

export interface GatewayToolTable<T extends UpstreamTool> {
  /** Tools to answer `tools/list` with, renamed and description-prefixed. */
  tools: T[];
  /** Exposed name → upstream server + original tool name. */
  routes: Map<string, GatewayRoute>;
}

/**
 * Merge every server's tool list into one table. Servers are taken in the given order; a
 * name collision (only possible after sanitizing + hashing) keeps the first and drops the
 * rest, so routing is always unambiguous.
 */
export function buildToolTable<T extends UpstreamTool>(lists: { server: string; tools: T[] }[]): GatewayToolTable<T> {
  const tools: T[] = [];
  const routes = new Map<string, GatewayRoute>();
  for (const { server, tools: list } of lists) {
    for (const tool of list) {
      if (typeof tool?.name !== 'string' || tool.name === '') continue;
      const exposed = gatewayToolName(server, tool.name);
      if (routes.has(exposed)) continue;
      routes.set(exposed, { server, tool: tool.name });
      const description = typeof tool.description === 'string' && tool.description !== '' ? `[${server}] ${tool.description}` : `[${server}]`;
      tools.push({ ...tool, name: exposed, description });
    }
  }
  return { tools, routes };
}

/** Per-agent state of the gateway entry in its MCP config. */
export type McpGatewayAgentState = 'absent' | 'same' | 'stale';

/**
 * Per library server: `off` (not served by the gateway), `on` (served), `stale` (added, but
 * the spec changed since the user confirmed it — not served until confirmed again).
 */
export type McpGatewayMembership = 'off' | 'on' | 'stale';

/** Runtime state of one served upstream (never carries output, args or values). */
export type McpGatewayUpstreamStatus = 'idle' | 'starting' | 'running' | 'failed';

/** One served upstream as the UI sees it: status and last tool count only. */
export interface McpGatewayUpstreamView {
  status: McpGatewayUpstreamStatus;
  /** Tools last listed, or null before the first successful listing. */
  tools: number | null;
}

/**
 * The gateway part of the MCP snapshot. Carries no token and no URL: the endpoint (with
 * its path token) is written into agent files by main and never crosses IPC.
 */
export interface McpGatewaySnapshot {
  /** The `mcpGateway` preference. */
  enabled: boolean;
  /** Per readable agent: whether its file has the gateway entry, and whether it is current. */
  agents: Partial<Record<string, McpGatewayAgentState>>;
  /** Per served server name. */
  upstreams: Record<string, McpGatewayUpstreamView>;
}
