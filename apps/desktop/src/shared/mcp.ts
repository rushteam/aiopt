// MCP servers — one library in AiOpt, written into each agent's own MCP config.
//
// A server spec is a COMMAND an agent will run (stdio) or a URL it will connect to
// (http / sse), so writing one into an agent config is a privileged act: main confirms
// every new or changed spec in a native dialog before it reaches any agent file (see
// docs/dev-rules/mcp-servers.md). Env and header VALUES are credentials: they live in the
// OS secret store and never cross into the renderer, which only sees their names.
//
// Pure types, limits and validation shared by main and the renderer.

/** Agents whose MCP config AiOpt can manage. */
export const MCP_AGENT_IDS = ['claude', 'codex', 'gemini'] as const;
export type McpAgentId = (typeof MCP_AGENT_IDS)[number];

export const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** Which transports each agent's config can express. Codex has no SSE client. */
export const MCP_AGENT_TRANSPORTS: Record<McpAgentId, readonly McpTransport[]> = {
  claude: ['stdio', 'http', 'sse'],
  codex: ['stdio', 'http'],
  gemini: ['stdio', 'http', 'sse'],
};

export function agentSupportsTransport(agentId: McpAgentId, transport: McpTransport): boolean {
  return MCP_AGENT_TRANSPORTS[agentId].includes(transport);
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
 * Where a library server stands in one agent's live config:
 * - `off`       — not enabled for this agent (AiOpt keeps it out of the file);
 * - `synced`    — enabled, and the agent file holds exactly what AiOpt would write;
 * - `missing`   — enabled, but the agent file has no entry by that name;
 * - `different` — enabled, but the entry was edited outside AiOpt (re-sync overwrites it).
 */
export type McpAgentState = 'off' | 'synced' | 'missing' | 'different';

export interface McpServerView extends McpServerShape {
  name: string;
  env: McpVarView[];
  headers: McpVarView[];
  agents: Record<McpAgentId, McpAgentState>;
}

/** A server found in an agent's config that is not in the library yet. */
export interface McpImportCandidate {
  agentId: McpAgentId;
  name: string;
  transport: McpTransport;
  /** `command args…` or the URL — for display; no env/header values. */
  summary: string;
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
  servers: McpServerView[];
  agents: McpAgentInfo[];
  candidates: McpImportCandidate[];
  /** False when the OS secret store is unavailable — env/header values cannot be saved. */
  secretsAvailable: boolean;
}

/** One env var / header in a save request; omit `value` to keep the stored one. */
export interface McpVarInput {
  key: string;
  value?: string;
}

export interface McpSaveRequest extends McpServerShape {
  name: string;
  /** Set when renaming or editing an existing server. */
  originalName?: string;
  env: McpVarInput[];
  headers: McpVarInput[];
  agents: McpAgentId[];
}

export interface McpToggleRequest {
  name: string;
  agentId: McpAgentId;
  enabled: boolean;
}

export interface McpNameRequest {
  name: string;
}

export interface McpImportRequest {
  agentId: McpAgentId;
  name: string;
}

/** `saved: false` — the user declined the write in the confirmation dialog. */
export interface McpWriteResult {
  saved: boolean;
  snapshot: McpSnapshot;
}

/** Shell-ish one-line summary of a spec, for the list and the confirmation dialog. */
export function mcpSummary(shape: McpServerShape): string {
  if (shape.transport === 'stdio') {
    const parts = [shape.command ?? '', ...(shape.args ?? [])];
    return parts.map((p) => (p === '' || /[\s"'\\]/.test(p) ? JSON.stringify(p) : p)).join(' ');
  }
  return shape.url ?? '';
}
