// Read and write the MCP servers in each agent's own config file.
//
//   claude — `~/.claude.json` → `mcpServers` (user scope). The file is Claude Code's large
//            state file, so only the `mcpServers` key is touched and every other key is
//            carried over as parsed.
//   codex  — `~/.codex/config.toml` → `[mcp_servers.<name>]` tables (see codexToml.ts).
//   gemini — `~/.gemini/settings.json` → `mcpServers`.
//
// Reads are STRICT, unlike the binding adapters' fail-open `readJsonObject`: a JSON file that
// exists but does not parse is reported `unreadable` and never written. Writing `{mcpServers}`
// over an unparseable `~/.claude.json` would drop the user's whole Claude state.
//
// Every write goes through `writeAgentConfigFile` (allowlist → backup once → atomic), and keeps
// the file's existing permission bits: these files now carry env/header values.

import fs from 'node:fs';
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

/** Parse one JSON-config entry. Claude marks the transport with `type`; Gemini by key. */
function fromJsonEntry(agentId: 'claude' | 'gemini', raw: unknown): LiveMcpServer | null {
  if (!isObject(raw)) return null;
  const env = stringMap(raw.env);
  const headers = stringMap(raw.headers);
  if (typeof raw.command === 'string') {
    return { transport: 'stdio', command: raw.command, args: stringArray(raw.args) ?? [], env, headers: {} };
  }
  if (agentId === 'claude') {
    if (typeof raw.url !== 'string') return null;
    const transport = raw.type === 'sse' ? 'sse' : raw.type === 'http' || raw.type === undefined ? 'http' : null;
    return transport ? { transport, url: raw.url, env: {}, headers } : null;
  }
  if (typeof raw.httpUrl === 'string') return { transport: 'http', url: raw.httpUrl, env: {}, headers };
  if (typeof raw.url === 'string') {
    return { transport: raw.type === 'http' ? 'http' : 'sse', url: raw.url, env: {}, headers };
  }
  return null;
}

/** Keys AiOpt renders; anything else in an existing entry (timeouts, `trust`, …) is kept. */
const MODELLED_KEYS = new Set(['type', 'command', 'args', 'env', 'url', 'httpUrl', 'headers']);

function toJsonEntry(agentId: 'claude' | 'gemini', s: LiveMcpServer, previous: unknown): Record<string, unknown> {
  const kept = isObject(previous)
    ? Object.fromEntries(Object.entries(previous).filter(([k]) => !MODELLED_KEYS.has(k)))
    : {};
  const hasEnv = Object.keys(s.env).length > 0;
  const hasHeaders = Object.keys(s.headers).length > 0;
  if (s.transport === 'stdio') {
    return {
      ...(agentId === 'claude' ? { type: 'stdio' } : {}),
      command: s.command,
      args: s.args ?? [],
      ...(hasEnv || agentId === 'claude' ? { env: s.env } : {}),
      ...kept,
    };
  }
  if (agentId === 'claude') {
    return { type: s.transport, url: s.url, ...(hasHeaders ? { headers: s.headers } : {}), ...kept };
  }
  return {
    ...(s.transport === 'http' ? { httpUrl: s.url } : { url: s.url }),
    ...(hasHeaders ? { headers: s.headers } : {}),
    ...kept,
  };
}

function fromCodex(e: ReturnType<typeof readCodexMcpServers> extends Map<string, infer V> ? V : never): LiveMcpServer | null {
  if (e.url !== undefined) return { transport: 'http', url: e.url, env: {}, headers: e.headers };
  if (e.command !== undefined) return { transport: 'stdio', command: e.command, args: e.args ?? [], env: e.env, headers: {} };
  return null;
}

export function readAgentMcp(agentId: McpAgentId): AgentMcpRead {
  let text: string | null;
  try {
    text = readText(mcpConfigPath(agentId));
  } catch {
    return { state: 'unreadable' };
  }
  const servers = new Map<string, LiveMcpServer>();
  if (text === null) return { state: 'ok', exists: false, servers };
  if (agentId === 'codex') {
    for (const [name, e] of readCodexMcpServers(text)) {
      const s = fromCodex(e);
      if (s) servers.set(name, s);
    }
    return { state: 'ok', exists: true, servers };
  }
  const doc = parseJsonObject(text);
  if (doc === undefined) return { state: 'unreadable' };
  const raw = doc.mcpServers;
  if (raw !== undefined && !isObject(raw)) return { state: 'unreadable' };
  for (const [name, entry] of Object.entries(raw ?? {})) {
    const s = fromJsonEntry(agentId, entry);
    if (s) servers.set(name, s);
  }
  return { state: 'ok', exists: true, servers };
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
  } else {
    const doc = text === null ? {} : parseJsonObject(text);
    if (doc === undefined || (doc.mcpServers !== undefined && !isObject(doc.mcpServers))) {
      throw new McpConfigUnreadableError(agentId);
    }
    const servers: Record<string, unknown> = { ...((doc.mcpServers as Record<string, unknown>) ?? {}) };
    for (const name of drop) delete servers[name];
    for (const [name, s] of put) servers[name] = toJsonEntry(agentId, s, servers[name]);
    next = `${JSON.stringify({ ...doc, mcpServers: servers }, null, 2)}\n`;
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
