// Read and write the MCP servers in each agent's own config file.
//
//   claude — `~/.claude.json` → `mcpServers` (user scope). The file is Claude Code's large
//            state file, so only the `mcpServers` key is touched and every other key is
//            carried over as parsed.
//   codex  — `~/.codex/config.toml` → `[mcp_servers.<name>]` tables (see codexToml.ts).
//   gemini — `~/.gemini/settings.json` → `mcpServers`.
//   cursor — `~/.cursor/mcp.json` → `mcpServers` (`url` for any remote server).
//   pi     — `~/.pi/agent/mcp.json` → `mcpServers` (no SSE; `type` optional).
//   opencode — `~/.config/opencode/opencode.json` → `mcp`: `{type: local, command: [...],
//            environment}` or `{type: remote, url, headers}`. The file is also the binding's.
//   hermes — `~/.hermes/config.yaml` → `mcp_servers`, edited as a YAML document so comments
//            and the binding's keys survive. The file is also the binding's.
//
// Reads are STRICT, unlike the binding adapters' fail-open `readJsonObject`: a JSON file that
// exists but does not parse is reported `unreadable` and never written. Writing `{mcpServers}`
// over an unparseable `~/.claude.json` would drop the user's whole Claude state.
//
// Every write goes through `writeAgentConfigFile` (allowlist → backup once → atomic), and keeps
// the file's existing permission bits: these files now carry env/header values.

import fs from 'node:fs';
import { isMap, parseDocument, type Document } from 'yaml';
import { MCP_CONFIG_FILES, resolveAgentFile } from '../providers/agentPaths';
import { writeAgentConfigFile } from '../providers/fsutil';
import type { McpAgentId, McpTransport } from '../../shared/mcp';
import { readCodexMcpServers, renderCodexMcpServer, replaceMcpBlocks } from './codexToml';

/** One server as an agent file expresses it, values included (main-only). */
export interface LiveMcpServer {
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
}

export type AgentMcpRead =
  | { state: 'ok'; exists: boolean; servers: Map<string, LiveMcpServer> }
  | { state: 'unreadable' };

export function mcpConfigPath(agentId: McpAgentId): string {
  return resolveAgentFile(MCP_CONFIG_FILES[agentId]);
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function stringMap(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

type JsonAgentId = Exclude<McpAgentId, 'codex' | 'hermes'>;

/** How one JSON-ish agent file names its servers section and shapes an entry. */
interface EntryFormat {
  /** Keys AiOpt renders; anything else in an existing entry (timeouts, `trust`, …) is kept. */
  modelled: ReadonlySet<string>;
  read(raw: Record<string, unknown>): LiveMcpServer | null;
  render(s: LiveMcpServer): Record<string, unknown>;
}

const hasKeys = (m: Record<string, string>): boolean => Object.keys(m).length > 0;

/** The common `{command, args, env}` / `{url, headers}` shape (Cursor, pi, Hermes). */
function plainFormat(opts: { sse: boolean }): EntryFormat {
  return {
    modelled: new Set(['type', 'command', 'args', 'env', 'url', 'headers']),
    read(raw) {
      const env = stringMap(raw.env);
      const headers = stringMap(raw.headers);
      if (typeof raw.command === 'string') {
        return { transport: 'stdio', command: raw.command, args: stringArray(raw.args) ?? [], env, headers: {} };
      }
      if (typeof raw.url !== 'string') return null;
      // pi (and Hermes) reject SSE; an entry that asks for it is not one AiOpt can model.
      if (!opts.sse && raw.type === 'sse') return null;
      return { transport: 'http', url: raw.url, env: {}, headers };
    },
    render(s) {
      if (s.transport === 'stdio') {
        return { command: s.command, args: s.args ?? [], ...(hasKeys(s.env) ? { env: s.env } : {}) };
      }
      return { url: s.url, ...(hasKeys(s.headers) ? { headers: s.headers } : {}) };
    },
  };
}

const JSON_FORMATS: Record<JsonAgentId | 'hermes', EntryFormat> = {
  // Claude marks the transport with `type`.
  claude: {
    modelled: new Set(['type', 'command', 'args', 'env', 'url', 'headers']),
    read(raw) {
      if (typeof raw.command === 'string') {
        return { transport: 'stdio', command: raw.command, args: stringArray(raw.args) ?? [], env: stringMap(raw.env), headers: {} };
      }
      if (typeof raw.url !== 'string') return null;
      const transport = raw.type === 'sse' ? 'sse' : raw.type === 'http' || raw.type === undefined ? 'http' : null;
      return transport ? { transport, url: raw.url, env: {}, headers: stringMap(raw.headers) } : null;
    },
    render(s) {
      if (s.transport === 'stdio') return { type: 'stdio', command: s.command, args: s.args ?? [], env: s.env };
      return { type: s.transport, url: s.url, ...(hasKeys(s.headers) ? { headers: s.headers } : {}) };
    },
  },
  // Gemini marks it by key: `httpUrl` = streamable HTTP, `url` = SSE.
  gemini: {
    modelled: new Set(['type', 'command', 'args', 'env', 'url', 'httpUrl', 'headers']),
    read(raw) {
      const headers = stringMap(raw.headers);
      if (typeof raw.command === 'string') {
        return { transport: 'stdio', command: raw.command, args: stringArray(raw.args) ?? [], env: stringMap(raw.env), headers: {} };
      }
      if (typeof raw.httpUrl === 'string') return { transport: 'http', url: raw.httpUrl, env: {}, headers };
      if (typeof raw.url === 'string') return { transport: raw.type === 'http' ? 'http' : 'sse', url: raw.url, env: {}, headers };
      return null;
    },
    render(s) {
      if (s.transport === 'stdio') {
        return { command: s.command, args: s.args ?? [], ...(hasKeys(s.env) ? { env: s.env } : {}) };
      }
      return {
        ...(s.transport === 'http' ? { httpUrl: s.url } : { url: s.url }),
        ...(hasKeys(s.headers) ? { headers: s.headers } : {}),
      };
    },
  },
  cursor: plainFormat({ sse: true }),
  pi: plainFormat({ sse: false }),
  hermes: plainFormat({ sse: false }),
  // OpenCode: the command and its args are one array; env is `environment`.
  opencode: {
    modelled: new Set(['type', 'command', 'environment', 'url', 'headers']),
    read(raw) {
      if (raw.type === 'local') {
        const cmd = stringArray(raw.command);
        if (!cmd || cmd.length === 0) return null;
        return { transport: 'stdio', command: cmd[0], args: cmd.slice(1), env: stringMap(raw.environment), headers: {} };
      }
      if (raw.type === 'remote' && typeof raw.url === 'string') {
        return { transport: 'http', url: raw.url, env: {}, headers: stringMap(raw.headers) };
      }
      return null;
    },
    render(s) {
      if (s.transport === 'stdio') {
        return {
          type: 'local',
          command: [s.command ?? '', ...(s.args ?? [])],
          ...(hasKeys(s.env) ? { environment: s.env } : {}),
        };
      }
      return { type: 'remote', url: s.url, ...(hasKeys(s.headers) ? { headers: s.headers } : {}) };
    },
  },
};

/** The key holding the servers map in each JSON file. */
const JSON_SECTION: Record<JsonAgentId, string> = {
  claude: 'mcpServers',
  gemini: 'mcpServers',
  cursor: 'mcpServers',
  pi: 'mcpServers',
  opencode: 'mcp',
};

export const HERMES_MCP_SECTION = 'mcp_servers';

/** Render `s` over `previous`, keeping the fields AiOpt does not model. */
function renderEntry(format: EntryFormat, s: LiveMcpServer, previous: unknown): Record<string, unknown> {
  const kept = isObject(previous)
    ? Object.fromEntries(Object.entries(previous).filter(([k]) => !format.modelled.has(k)))
    : {};
  return { ...format.render(s), ...kept };
}

function readEntries(format: EntryFormat, raw: Record<string, unknown>): Map<string, LiveMcpServer> {
  const servers = new Map<string, LiveMcpServer>();
  for (const [name, entry] of Object.entries(raw)) {
    const s = isObject(entry) ? format.read(entry) : null;
    if (s) servers.set(name, s);
  }
  return servers;
}

function fromCodex(e: ReturnType<typeof readCodexMcpServers> extends Map<string, infer V> ? V : never): LiveMcpServer | null {
  if (e.url !== undefined) return { transport: 'http', url: e.url, env: {}, headers: e.headers };
  if (e.command !== undefined) return { transport: 'stdio', command: e.command, args: e.args ?? [], env: e.env, headers: {} };
  return null;
}

/**
 * A YAML document whose root is a map (or empty), and whose `mcp_servers` is a map or absent.
 * Anything else is `undefined`: unreadable, never written.
 */
function parseHermesDoc(text: string): Document.Parsed | undefined {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return undefined;
  if (doc.contents !== null && !isMap(doc.contents)) return undefined;
  const section = doc.get(HERMES_MCP_SECTION, true);
  if (section !== undefined && section !== null && !isMap(section)) return undefined;
  return doc;
}

export function readAgentMcp(agentId: McpAgentId): AgentMcpRead {
  let text: string | null;
  try {
    text = readText(mcpConfigPath(agentId));
  } catch {
    return { state: 'unreadable' };
  }
  if (text === null) return { state: 'ok', exists: false, servers: new Map() };
  if (agentId === 'codex') {
    const servers = new Map<string, LiveMcpServer>();
    for (const [name, e] of readCodexMcpServers(text)) {
      const s = fromCodex(e);
      if (s) servers.set(name, s);
    }
    return { state: 'ok', exists: true, servers };
  }
  if (agentId === 'hermes') {
    const doc = parseHermesDoc(text);
    if (!doc) return { state: 'unreadable' };
    const raw: unknown = doc.toJS()?.[HERMES_MCP_SECTION];
    return { state: 'ok', exists: true, servers: readEntries(JSON_FORMATS.hermes, isObject(raw) ? raw : {}) };
  }
  const doc = parseJsonObject(text);
  if (doc === undefined) return { state: 'unreadable' };
  const raw = doc[JSON_SECTION[agentId]];
  if (raw !== undefined && !isObject(raw)) return { state: 'unreadable' };
  return { state: 'ok', exists: true, servers: readEntries(JSON_FORMATS[agentId], raw ?? {}) };
}

/** `undefined` for "not a JSON object"; an empty file counts as `{}`. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (text.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Existing permission bits, or owner-only for a file AiOpt creates (it may hold values). */
function modeFor(file: string): number | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return 0o600;
  }
}

export class McpConfigUnreadableError extends Error {}

/**
 * Upsert `put` and delete `drop` in one agent's file, in a single read-modify-write.
 * Names in neither set are left exactly as they are.
 */
export function writeAgentMcp(
  agentId: McpAgentId,
  put: ReadonlyMap<string, LiveMcpServer>,
  drop: ReadonlySet<string>,
): void {
  const file = mcpConfigPath(agentId);
  const text = readText(file);
  let next: string;
  if (agentId === 'codex') {
    const live = readCodexMcpServers(text ?? '');
    const rendered = [...put].map(([name, s]) =>
      renderCodexMcpServer(name, s, live.get(name) ?? { extraLines: [], extraBlocks: [] }),
    );
    next = replaceMcpBlocks(text ?? '', new Set([...put.keys(), ...drop]), rendered.join('\n\n'));
  } else if (agentId === 'hermes') {
    const doc = parseHermesDoc(text ?? '');
    if (!doc) throw new McpConfigUnreadableError(agentId);
    const current: unknown = doc.toJS()?.[HERMES_MCP_SECTION];
    const previous = isObject(current) ? current : {};
    // `deleteIn` throws when the section itself is missing, so only drop names that exist.
    for (const name of drop) if (Object.hasOwn(previous, name)) doc.deleteIn([HERMES_MCP_SECTION, name]);
    for (const [name, s] of put) {
      doc.setIn([HERMES_MCP_SECTION, name], doc.createNode(renderEntry(JSON_FORMATS.hermes, s, previous[name])));
    }
    // `mcp_servers: {}` is a flow map; entries added to it would stay on one line.
    const section = doc.get(HERMES_MCP_SECTION, true);
    if (isMap(section) && section.items.length > 0) section.flow = false;
    next = doc.toString();
  } else {
    const section = JSON_SECTION[agentId];
    const doc = text === null ? {} : parseJsonObject(text);
    if (doc === undefined || (doc[section] !== undefined && !isObject(doc[section]))) {
      throw new McpConfigUnreadableError(agentId);
    }
    const servers: Record<string, unknown> = { ...((doc[section] as Record<string, unknown>) ?? {}) };
    for (const name of drop) delete servers[name];
    for (const [name, s] of put) servers[name] = renderEntry(JSON_FORMATS[agentId], s, servers[name]);
    next = `${JSON.stringify({ ...doc, [section]: servers }, null, 2)}\n`;
  }
  writeAgentConfigFile(file, next, modeFor(file));
}

/** Same server, ignoring anything AiOpt does not model. */
export function sameMcpServer(a: LiveMcpServer, b: LiveMcpServer): boolean {
  if (a.transport !== b.transport) return false;
  if (a.transport === 'stdio') {
    return a.command === b.command && sameList(a.args ?? [], b.args ?? []) && sameMap(a.env, b.env);
  }
  return a.url === b.url && sameMap(a.headers, b.headers);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}
