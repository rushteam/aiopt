// MCP servers — one library in AiOpt, written into each agent's own MCP config.
//
// A server spec is a COMMAND an agent will run (stdio) or a URL it will connect to
// (http / sse), so writing one into an agent config is a privileged act: main confirms
// every new or changed spec in a native dialog before it reaches any agent file (see
// docs/dev-rules/mcp-servers.md). Env and header VALUES are credentials: they live in the
// OS secret store and never cross into the renderer, which only sees their names.
//
// Pure types, limits and validation shared by main and the renderer.

import type { McpGatewayMembership, McpGatewaySnapshot } from './mcpGateway';

/** Agents whose MCP config AiOpt can manage. */
export const MCP_AGENT_IDS = ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'pi', 'hermes'] as const;
export type McpAgentId = (typeof MCP_AGENT_IDS)[number];

export const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/**
 * Which transports each agent's config can express. Codex, pi and Hermes have no SSE client.
 * Cursor and OpenCode take a bare remote `url` and pick streamable HTTP or SSE themselves.
 */
export const MCP_AGENT_TRANSPORTS: Record<McpAgentId, readonly McpTransport[]> = {
  claude: ['stdio', 'http', 'sse'],
  codex: ['stdio', 'http'],
  gemini: ['stdio', 'http', 'sse'],
  cursor: ['stdio', 'http', 'sse'],
  opencode: ['stdio', 'http', 'sse'],
  pi: ['stdio', 'http'],
  hermes: ['stdio', 'http'],
};

export function agentSupportsTransport(agentId: McpAgentId, transport: McpTransport): boolean {
  return MCP_AGENT_TRANSPORTS[agentId].includes(transport);
}

/**
 * Whether an agent's file can tell SSE from streamable HTTP. The others store only a `url`,
 * so every remote server reads back as `http` and is compared that way.
 */
export function agentNamesRemoteTransport(agentId: McpAgentId): boolean {
  return agentId === 'claude' || agentId === 'gemini';
}

/** Agents with a stricter server-name charset than {@link MCP_NAME_RE}. pi refuses `.`. */
const MCP_AGENT_NAME_RE: Partial<Record<McpAgentId, RegExp>> = {
  pi: /^[A-Za-z0-9_-]+$/,
};

/** Whether this server (its name and transport) can be written into this agent's file. */
export function agentAcceptsServer(agentId: McpAgentId, name: string, transport: McpTransport): boolean {
  return agentSupportsTransport(agentId, transport) && (MCP_AGENT_NAME_RE[agentId]?.test(name) ?? true);
}

export const MCP_LIMITS = {
  maxServers: 200,
  maxCommand: 1024,
  maxArgs: 64,
  maxArg: 4096,
  maxUrl: 2048,
  maxVars: 64,
  maxVarValue: 8192,
} as const;

/** Server name: also the key in every agent config, so a conservative charset. */
export const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Environment variable name. */
export const MCP_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** HTTP header field name (RFC 9110 token chars, no `_` games). */
export const MCP_HEADER_KEY_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

export function isMcpName(value: unknown): value is string {
  return typeof value === 'string' && MCP_NAME_RE.test(value);
}

/** What makes up a server, minus credential values. */
export interface McpServerShape {
  transport: McpTransport;
  /** stdio only. */
  command?: string;
  /** stdio only. */
  args?: string[];
  /** http / sse only. */
  url?: string;
}

/** A named env var or header; `set` says whether a value is stored (never the value). */
export interface McpVarView {
  key: string;
  set: boolean;
}

/**
 * How a server compares between the library and one agent's live config, the same four
 * states as skills:
 * - `same`         — both have it and the agent file holds exactly what the library would write;
 * - `library-only` — only the library has it (push writes it in);
 * - `agent-only`   — only the agent file has it (pull adopts it into the library);
 * - `differs`      — both have it, with different specs or values (diff, then pick a side).
 */
export type McpSyncState = 'same' | 'library-only' | 'agent-only' | 'differs';

/** A library server, minus credential values. */
export interface McpServerView extends McpServerShape {
  name: string;
  env: McpVarView[];
  headers: McpVarView[];
  /** Whether the MCP gateway serves it (see docs/dev-rules/mcp-gateway.md). */
  gateway: McpGatewayMembership;
}

/** A server as an agent file has it: spec and key names, never values. */
export interface McpAgentEntry extends McpServerShape {
  envKeys: string[];
  headerKeys: string[];
}

/** One agent's cell in a matrix row. */
export interface McpCell {
  state: McpSyncState;
  entry: McpAgentEntry | null;
  /** The library spec can be written into this agent (Codex has no SSE). */
  supported: boolean;
}

/**
 * One row of the sync matrix: the union of names in the library and in every readable agent
 * file. An agent key is absent when neither side has the server, or the agent file is unreadable.
 */
export interface McpMatrixRow {
  name: string;
  library: McpServerView | null;
  agents: Partial<Record<McpAgentId, McpCell>>;
}

export interface McpAgentInfo {
  agentId: McpAgentId;
  installed: boolean;
  /** Home-shortened path of the file AiOpt writes, for display. */
  configDisplayPath: string;
  /** The agent file exists but could not be read as config; AiOpt will not write it. */
  unreadable: boolean;
}

export interface McpSnapshot {
  rows: McpMatrixRow[];
  agents: McpAgentInfo[];
  /** False when the OS secret store is unavailable — env/header values cannot be saved. */
  secretsAvailable: boolean;
  gateway: McpGatewaySnapshot;
}

/** Add (`on`) or remove the gateway entry in these agents' MCP configs. */
export interface McpGatewayAgentsRequest {
  agentIds: McpAgentId[];
  on: boolean;
}

/** Serve (or stop serving) one library server through the gateway. */
export interface McpGatewayServerRequest extends McpNameRequest {
  on: boolean;
}

/** Formats main may write to the OS clipboard for the gateway endpoint. */
export type McpGatewayCopyFormat = 'url' | 'json';

/**
 * Copy the live gateway endpoint to the clipboard (main-side). The URL embeds the
 * path token, so the result deliberately carries no endpoint data — only whether
 * the write happened. Format `url` = bare URL; `json` = an `mcpServers.aiopt` snippet.
 */
export interface McpCopyGatewayEndpointRequest {
  format: McpGatewayCopyFormat;
}

export interface McpCopyGatewayEndpointResult {
  copied: boolean;
}

/** One env var / header in a save request; omit `value` to keep the stored one. */
export interface McpVarInput {
  key: string;
  value?: string;
}

/** Saves into the library only; agents change only on push. */
export interface McpSaveRequest extends McpServerShape {
  name: string;
  /** Set when renaming or editing an existing server. */
  originalName?: string;
  env: McpVarInput[];
  headers: McpVarInput[];
}

export interface McpNameRequest {
  name: string;
}

export interface McpAgentRequest {
  agentId: McpAgentId;
  name: string;
}

export interface McpPushRequest {
  name: string;
  agentIds: McpAgentId[];
}

export interface McpMergeRequest extends McpAgentRequest {
  /** Field ids from the diff whose agent side the library takes. */
  agentPicks: string[];
}

/**
 * GATED: read ONE stored env / header value of a library server in plaintext, so the edit
 * form can show and change it. Unlike every other MCP channel the result DOES carry a value —
 * the deliberate, per-click exception documented in mcp-servers.md §2.
 */
export interface McpRevealValueRequest extends McpNameRequest {
  kind: 'env' | 'header';
  key: string;
}

/** `value` is null when the server or key has no stored value. */
export interface McpRevealValueResult {
  value: string | null;
}

/** `saved: false` — the user declined the write in the confirmation dialog. */
export interface McpWriteResult {
  saved: boolean;
  snapshot: McpSnapshot;
}

/**
 * One differing field, relative to the library (as skills' files are):
 * `added` = only the library has it, `deleted` = only the agent has it, `modified` = both differ.
 * Field ids: `spec` (transport + command/args or url), `env:<KEY>`, `header:<KEY>`.
 * `library` / `agent` carry the spec summaries for `spec` only — env/header VALUES never leave main.
 */
export interface McpFieldDiff {
  field: string;
  kind: 'spec' | 'env' | 'header';
  key?: string;
  status: 'added' | 'modified' | 'deleted';
  library?: string;
  agent?: string;
}

export interface McpDiffResult {
  agentId: McpAgentId;
  name: string;
  fields: McpFieldDiff[];
}

/** Shell-ish one-line summary of a spec, for the list and the confirmation dialog. */
export function mcpSummary(shape: McpServerShape): string {
  if (shape.transport === 'stdio') {
    const parts = [shape.command ?? '', ...(shape.args ?? [])];
    return parts.map((p) => (p === '' || /[\s"'\\]/.test(p) ? JSON.stringify(p) : p)).join(' ');
  }
  return shape.url ?? '';
}
