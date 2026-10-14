// The MCP server library and its sync into agent configs.
//
// Library (userData/mcp-servers.json): name, transport, command/args or url, env/header KEYS,
// and which agents each server is enabled for. Values: one main-only secret per server
// (`main_mcp_<hex name>`) holding `{ env, headers }`. The renderer never sees a value.
//
// Writes into agent files happen only for agents a server is enabled for, and every save or
// enable that puts a spec into an agent file is confirmed first through the injected
// `confirmWrite` — a main-side native dialog the renderer cannot answer.

import { readUtf8WithoutBom, writeFileAtomicSync } from '../storeFile';
import { throwIpcError } from '../ipc/validate';
import { MAIN_ONLY_SECRET_PREFIX, type SecretStore } from '../secrets/secretStore';
import { logger } from '../logger';
import {
  MCP_AGENT_IDS,
  MCP_ENV_KEY_RE,
  MCP_HEADER_KEY_RE,
  MCP_LIMITS,
  agentSupportsTransport,
  isMcpName,
  mcpSummary,
  type McpAgentId,
  type McpAgentInfo,
  type McpAgentState,
  type McpImportCandidate,
  type McpSaveRequest,
  type McpServerShape,
  type McpSnapshot,
  type McpTransport,
  type McpWriteResult,
} from '../../shared/mcp';
import {
  McpConfigUnreadableError,
  mcpConfigPath,
  readAgentMcp,
  sameMcpServer,
  writeAgentMcp,
  type AgentMcpRead,
  type LiveMcpServer,
} from './agentMcpConfig';

const log = logger.child('mcp');

interface LibraryServer extends McpServerShape {
  name: string;
  envKeys: string[];
  headerKeys: string[];
  agents: McpAgentId[];
}

interface LibraryDoc {
  servers: LibraryServer[];
}

interface Values {
  env: Record<string, string>;
  headers: Record<string, string>;
}

/** What the confirmation dialog shows. Keys only — never env/header values. */
export interface McpConfirmRequest {
  name: string;
  summary: string;
  transport: McpTransport;
  agentIds: McpAgentId[];
  envKeys: string[];
  headerKeys: string[];
}

export interface McpStoreDeps {
  filePath: string;
  secrets: SecretStore;
  /** One dialog for one or more servers; resolves true only on an explicit confirm. */
  confirmWrite: (reqs: McpConfirmRequest[]) => Promise<boolean>;
  /** Install signal per agent (the agent's config dir exists). */
  isInstalled: (agentId: McpAgentId) => boolean;
  displayPath: (abs: string) => string;
}

function secretKey(name: string): string {
  return `${MAIN_ONLY_SECRET_PREFIX}mcp_${Buffer.from(name, 'utf8').toString('hex')}`;
}

function validLibraryServer(raw: unknown): LibraryServer | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isMcpName(o.name)) return null;
  if (o.transport !== 'stdio' && o.transport !== 'http' && o.transport !== 'sse') return null;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const agents = strings(o.agents).filter((a): a is McpAgentId =>
    (MCP_AGENT_IDS as readonly string[]).includes(a),
  );
  const base = { name: o.name, envKeys: strings(o.envKeys), headerKeys: strings(o.headerKeys), agents };
  if (o.transport === 'stdio') {
    if (typeof o.command !== 'string' || o.command === '') return null;
    return { ...base, transport: 'stdio', command: o.command, args: strings(o.args) };
  }
  if (typeof o.url !== 'string' || o.url === '') return null;
  return { ...base, transport: o.transport, url: o.url };
}

function loadDoc(filePath: string): LibraryDoc {
  try {
    const raw: unknown = JSON.parse(readUtf8WithoutBom(filePath));
    const list = (raw as { servers?: unknown })?.servers;
    if (!Array.isArray(list)) return { servers: [] };
    const seen = new Set<string>();
    const servers: LibraryServer[] = [];
    for (const item of list) {
      const s = validLibraryServer(item);
      if (s && !seen.has(s.name)) {
        seen.add(s.name);
        servers.push(s);
      }
    }
    return { servers };
  } catch {
    return { servers: [] };
  }
}

/** Validate a renderer save request (shape, limits, transport/agent fit). */
export function validateSaveRequest(raw: unknown): McpSaveRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throwIpcError('INVALID_PARAMS', 'payload must be an object');
  const o = raw as Record<string, unknown>;
  if (!isMcpName(o.name)) throwIpcError('INVALID_PARAMS', 'invalid server name');
  if (o.originalName !== undefined && !isMcpName(o.originalName)) throwIpcError('INVALID_PARAMS', 'invalid originalName');
  if (o.transport !== 'stdio' && o.transport !== 'http' && o.transport !== 'sse') {
    throwIpcError('INVALID_PARAMS', 'invalid transport');
  }
  const transport = o.transport;
  const out: McpSaveRequest = {
    name: o.name,
    ...(o.originalName !== undefined ? { originalName: o.originalName as string } : {}),
    transport,
    env: [],
    headers: [],
    agents: [],
  };
  if (transport === 'stdio') {
    if (typeof o.command !== 'string' || o.command.trim() === '' || o.command.length > MCP_LIMITS.maxCommand) {
      throwIpcError('INVALID_PARAMS', 'invalid command');
    }
    if (!Array.isArray(o.args) || o.args.length > MCP_LIMITS.maxArgs) throwIpcError('INVALID_PARAMS', 'invalid args');
    for (const a of o.args) {
      if (typeof a !== 'string' || a.length > MCP_LIMITS.maxArg) throwIpcError('INVALID_PARAMS', 'invalid arg');
    }
    out.command = o.command.trim();
    out.args = [...(o.args as string[])];
  } else {
    if (typeof o.url !== 'string' || o.url.length > MCP_LIMITS.maxUrl) throwIpcError('INVALID_PARAMS', 'invalid url');
    let parsed: URL;
    try {
      parsed = new URL(o.url.trim());
    } catch {
      throwIpcError('INVALID_PARAMS', 'invalid url');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throwIpcError('INVALID_PARAMS', 'url must be http(s)');
    if (parsed.username !== '' || parsed.password !== '') throwIpcError('INVALID_PARAMS', 'put credentials in a header, not the url');
    out.url = o.url.trim();
  }
  // Env vars belong to a spawned process, headers to a connection: each only on its transport.
  out.env = transport === 'stdio' ? vars(o.env, MCP_ENV_KEY_RE, 'env') : vars(o.env, null, 'env');
  out.headers = transport === 'stdio' ? vars(o.headers, null, 'headers') : vars(o.headers, MCP_HEADER_KEY_RE, 'headers');
  if (!Array.isArray(o.agents)) throwIpcError('INVALID_PARAMS', 'agents must be an array');
  const agents = new Set<McpAgentId>();
  for (const a of o.agents) {
    if (!(MCP_AGENT_IDS as readonly unknown[]).includes(a)) throwIpcError('INVALID_PARAMS', 'invalid agent');
    if (!agentSupportsTransport(a as McpAgentId, transport)) {
      throwIpcError('UNSUPPORTED_CAPABILITY', `${String(a)} does not support ${transport} servers`);
    }
    agents.add(a as McpAgentId);
  }
  out.agents = MCP_AGENT_IDS.filter((a) => agents.has(a));
  return out;
}

/** `keyRe: null` — this transport takes none: the list must be empty. */
function vars(raw: unknown, keyRe: RegExp | null, name: string): { key: string; value?: string }[] {
  if (!Array.isArray(raw) || raw.length > MCP_LIMITS.maxVars) throwIpcError('INVALID_PARAMS', `invalid ${name}`);
  if (keyRe === null) {
    if (raw.length > 0) throwIpcError('INVALID_PARAMS', `${name} not supported for this transport`);
    return [];
  }
  const seen = new Set<string>();
  return raw.map((item) => {
    if (!item || typeof item !== 'object') throwIpcError('INVALID_PARAMS', `invalid ${name}`);
    const { key, value } = item as { key?: unknown; value?: unknown };
    if (typeof key !== 'string' || !keyRe.test(key) || seen.has(key.toLowerCase())) {
      throwIpcError('INVALID_PARAMS', `invalid ${name} key`);
    }
    seen.add(key.toLowerCase());
    if (value !== undefined && (typeof value !== 'string' || value.length > MCP_LIMITS.maxVarValue || /[\r\n\u0000]/.test(value))) {
      throwIpcError('INVALID_PARAMS', `invalid ${name} value`);
    }
    return value === undefined ? { key } : { key, value: value as string };
  });
}

function toLive(s: LibraryServer, v: Values): LiveMcpServer {
  return s.transport === 'stdio'
    ? { transport: 'stdio', command: s.command, args: s.args ?? [], env: pick(v.env, s.envKeys), headers: {} }
    : { transport: s.transport, url: s.url, env: {}, headers: pick(v.headers, s.headerKeys) };
}

function pick(map: Record<string, string>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) if (Object.hasOwn(map, k)) out[k] = map[k]!;
  return out;
}

/** Codex's config cannot say SSE, and its HTTP entries are read back as `http`. */
function liveTransportFor(agentId: McpAgentId, s: LiveMcpServer): LiveMcpServer {
  return agentId === 'codex' && s.transport !== 'stdio' ? { ...s, transport: 'http' } : s;
}

export function createMcpStore(deps: McpStoreDeps) {
  let doc = loadDoc(deps.filePath);

  const persist = (): void => {
    writeFileAtomicSync(deps.filePath, `${JSON.stringify(doc, null, 2)}\n`);
  };

  const readValues = (name: string): Values => {
    const raw = deps.secrets.get(secretKey(name));
    if (!raw) return { env: {}, headers: {} };
    try {
      const v = JSON.parse(raw) as Partial<Values>;
      return { env: { ...(v.env ?? {}) }, headers: { ...(v.headers ?? {}) } };
    } catch {
      return { env: {}, headers: {} };
    }
  };

  const writeValues = (name: string, v: Values): void => {
    if (Object.keys(v.env).length === 0 && Object.keys(v.headers).length === 0) {
      deps.secrets.delete(secretKey(name));
      return;
    }
    if (!deps.secrets.isAvailable()) throwIpcError('PRECONDITION_FAILED', 'OS secret encryption is unavailable');
    deps.secrets.set(secretKey(name), JSON.stringify(v));
  };

  const find = (name: string): LibraryServer | undefined => doc.servers.find((s) => s.name === name);

  const readAll = (): Record<McpAgentId, AgentMcpRead> =>
    Object.fromEntries(MCP_AGENT_IDS.map((a) => [a, readAgentMcp(a)])) as Record<McpAgentId, AgentMcpRead>;

  /** Refuse before any write if a target file exists but cannot be parsed. */
  const assertWritable = (agentIds: Iterable<McpAgentId>): void => {
    for (const a of agentIds) {
      if (readAgentMcp(a).state === 'unreadable') {
        throwIpcError('PRECONDITION_FAILED', `${a} MCP config could not be read; fix or move it first`);
      }
    }
  };

  const applyToAgents = (writes: Map<McpAgentId, { put: Map<string, LiveMcpServer>; drop: Set<string> }>): void => {
    const written: McpAgentId[] = [];
    for (const [agentId, { put, drop }] of writes) {
      if (put.size === 0 && drop.size === 0) continue;
      written.push(agentId);
      try {
        writeAgentMcp(agentId, put, drop);
      } catch (err) {
        log.warn('mcp.write_failed', { agentId, error: err instanceof McpConfigUnreadableError ? 'unreadable' : String((err as Error).message ?? err) });
        throwIpcError('INTERNAL', `could not write ${agentId} MCP config`);
      }
    }
    if (written.length > 0) log.info('mcp.synced', { agents: written.join(',') });
  };

  const emptyWrites = () =>
    new Map<McpAgentId, { put: Map<string, LiveMcpServer>; drop: Set<string> }>(
      MCP_AGENT_IDS.map((a) => [a, { put: new Map(), drop: new Set() }]),
    );

  const confirmFor = (s: LibraryServer, agentIds: McpAgentId[]): McpConfirmRequest => ({
    name: s.name,
    summary: mcpSummary(s),
    transport: s.transport,
    agentIds,
    envKeys: s.envKeys,
    headerKeys: s.headerKeys,
  });

  return {
    snapshot(): McpSnapshot {
      const live = readAll();
      const libraryNames = new Set(doc.servers.map((s) => s.name));
      const servers = doc.servers.map((s) => {
        const values = readValues(s.name);
        const want = toLive(s, values);
        const agents = Object.fromEntries(
          MCP_AGENT_IDS.map((a): [McpAgentId, McpAgentState] => {
            if (!s.agents.includes(a)) return [a, 'off'];
            const r = live[a];
            if (r.state !== 'ok') return [a, 'different'];
            const got = r.servers.get(s.name);
            if (!got) return [a, 'missing'];
            return [a, sameMcpServer(liveTransportFor(a, want), got) ? 'synced' : 'different'];
          }),
        ) as Record<McpAgentId, McpAgentState>;
        return {
          name: s.name,
          transport: s.transport,
          ...(s.transport === 'stdio' ? { command: s.command, args: s.args } : { url: s.url }),
          env: s.envKeys.map((key) => ({ key, set: Object.hasOwn(values.env, key) })),
          headers: s.headerKeys.map((key) => ({ key, set: Object.hasOwn(values.headers, key) })),
          agents,
        };
      });
      const candidates: McpImportCandidate[] = [];
      const agents: McpAgentInfo[] = MCP_AGENT_IDS.map((agentId) => {
        const r = live[agentId];
        if (r.state === 'ok') {
          for (const [name, s] of r.servers) {
            if (!libraryNames.has(name) && isMcpName(name)) {
              candidates.push({ agentId, name, transport: s.transport, summary: mcpSummary(s) });
            }
          }
        }
        return {
          agentId,
          installed: deps.isInstalled(agentId),
          configDisplayPath: deps.displayPath(mcpConfigPath(agentId)),
          unreadable: r.state === 'unreadable',
        };
      });
      return { servers, agents, candidates, secretsAvailable: deps.secrets.isAvailable() };
    },

    async save(req: McpSaveRequest): Promise<McpWriteResult> {
      const previous = req.originalName !== undefined ? find(req.originalName) : undefined;
      if (req.originalName !== undefined && !previous) throwIpcError('NOT_FOUND', 'server not found');
      if (req.name !== req.originalName && find(req.name)) throwIpcError('ALREADY_EXISTS', 'a server with this name exists');
      if (!previous && doc.servers.length >= MCP_LIMITS.maxServers) throwIpcError('PRECONDITION_FAILED', 'too many servers');

      // Omitted values keep the stored one, but only under the same server and key.
      const old = previous ? readValues(previous.name) : { env: {}, headers: {} };
      const values: Values = { env: {}, headers: {} };
      for (const [list, into, from] of [
        [req.env, values.env, old.env],
        [req.headers, values.headers, old.headers],
      ] as const) {
        for (const { key, value } of list) {
          if (value !== undefined) into[key] = value;
          else if (Object.hasOwn(from, key)) into[key] = from[key]!;
        }
      }
      const next: LibraryServer = {
        name: req.name,
        transport: req.transport,
        ...(req.transport === 'stdio' ? { command: req.command, args: req.args ?? [] } : { url: req.url }),
        envKeys: req.env.map((v) => v.key),
        headerKeys: req.headers.map((v) => v.key),
        agents: req.agents,
      };
      const writes = emptyWrites();
      for (const a of next.agents) writes.get(a)!.put.set(next.name, toLive(next, values));
      if (previous) {
        for (const a of previous.agents) {
          if (!next.agents.includes(a) || previous.name !== next.name) writes.get(a)!.drop.add(previous.name);
        }
      }
      const touched = MCP_AGENT_IDS.filter((a) => writes.get(a)!.put.size + writes.get(a)!.drop.size > 0);
      assertWritable(touched);
      if (Object.keys(values.env).length + Object.keys(values.headers).length > 0 && !deps.secrets.isAvailable()) {
        throwIpcError('PRECONDITION_FAILED', 'OS secret encryption is unavailable');
      }
      if (next.agents.length > 0 && !(await deps.confirmWrite([confirmFor(next, next.agents)]))) {
        return { saved: false, snapshot: this.snapshot() };
      }
      writeValues(next.name, values);
      if (previous && previous.name !== next.name) deps.secrets.delete(secretKey(previous.name));
      doc = {
        servers: previous
          ? doc.servers.map((s) => (s.name === previous.name ? next : s))
          : [...doc.servers, next],
      };
      persist();
      applyToAgents(writes);
      return { saved: true, snapshot: this.snapshot() };
    },

    async toggle(name: string, agentId: McpAgentId, enabled: boolean): Promise<McpWriteResult> {
      const s = find(name);
      if (!s) throwIpcError('NOT_FOUND', 'server not found');
      if (enabled === s.agents.includes(agentId)) return { saved: true, snapshot: this.snapshot() };
      if (enabled && !agentSupportsTransport(agentId, s.transport)) {
        throwIpcError('UNSUPPORTED_CAPABILITY', `${agentId} does not support ${s.transport} servers`);
      }
      assertWritable([agentId]);
      if (enabled && !(await deps.confirmWrite([confirmFor(s, [agentId])]))) {
        return { saved: false, snapshot: this.snapshot() };
      }
      const updated: LibraryServer = {
        ...s,
        agents: enabled ? MCP_AGENT_IDS.filter((a) => a === agentId || s.agents.includes(a)) : s.agents.filter((a) => a !== agentId),
      };
      doc = { servers: doc.servers.map((x) => (x.name === name ? updated : x)) };
      persist();
      const writes = emptyWrites();
      if (enabled) writes.get(agentId)!.put.set(name, toLive(s, readValues(name)));
      else writes.get(agentId)!.drop.add(name);
      applyToAgents(writes);
      return { saved: true, snapshot: this.snapshot() };
    },

    /** Rewrite a server into every agent it is enabled for (fixes `missing` / `different`). */
    resync(name: string): McpSnapshot {
      const s = find(name);
      if (!s) throwIpcError('NOT_FOUND', 'server not found');
      assertWritable(s.agents);
      const writes = emptyWrites();
      const live = toLive(s, readValues(name));
      for (const a of s.agents) writes.get(a)!.put.set(name, live);
      applyToAgents(writes);
      return this.snapshot();
    },

    remove(name: string): McpSnapshot {
      const s = find(name);
      if (!s) throwIpcError('NOT_FOUND', 'server not found');
      assertWritable(s.agents);
      const writes = emptyWrites();
      for (const a of s.agents) writes.get(a)!.drop.add(name);
      doc = { servers: doc.servers.filter((x) => x.name !== name) };
      persist();
      deps.secrets.delete(secretKey(name));
      applyToAgents(writes);
      return this.snapshot();
    },

    enabledSets(): McpEnabledSets {
      const out: McpEnabledSets = {};
      for (const a of MCP_AGENT_IDS) out[a] = doc.servers.filter((s) => s.agents.includes(a)).map((s) => s.name);
      return out;
    },

    /**
     * Plan making each agent's enabled servers equal the given sets (agents absent from
     * `sets` are left alone). Enabling writes commands into agent files, so a non-empty
     * enable list goes through ONE confirmation; disabling only removes and needs none.
     * Unreadable target files refuse the whole plan before the dialog.
     */
    async planEnabledSets(sets: McpEnabledSets): Promise<McpEnabledSetsPlan> {
      const diff = () => {
        const enable = new Map<string, McpAgentId[]>();
        const disable = new Map<string, McpAgentId[]>();
        let skipped = 0;
        for (const a of MCP_AGENT_IDS) {
          const want = sets[a];
          if (!want) continue;
          const wanted = new Set(want);
          for (const n of wanted) {
            const s = find(n);
            if (!s || !agentSupportsTransport(a, s.transport)) skipped += 1;
          }
          for (const s of doc.servers) {
            const on = s.agents.includes(a);
            const should = wanted.has(s.name) && agentSupportsTransport(a, s.transport);
            const into = should && !on ? enable : !should && on ? disable : null;
            if (into) into.set(s.name, [...(into.get(s.name) ?? []), a]);
          }
        }
        return { enable, disable, skipped };
      };
      const planned = diff();
      const touched = new Set<McpAgentId>();
      for (const m of [planned.enable, planned.disable]) for (const agents of m.values()) agents.forEach((a) => touched.add(a));
      assertWritable(touched);
      // What the user saw: name → spec summary, so a spec edited during the dialog is not written.
      const confirmed = new Map<string, string>();
      if (planned.enable.size > 0) {
        const reqs = [...planned.enable].map(([n, agents]) => confirmFor(find(n)!, agents));
        if (!(await deps.confirmWrite(reqs))) return { proceed: false, skipped: planned.skipped, commit: () => {} };
        for (const r of reqs) confirmed.set(r.name, r.summary);
      }
      return {
        proceed: true,
        skipped: planned.skipped,
        commit: () => {
          const { enable, disable } = diff();
          const writes = emptyWrites();
          const nextAgents = new Map(doc.servers.map((s) => [s.name, new Set(s.agents)]));
          for (const [n, agents] of disable) {
            for (const a of agents) {
              nextAgents.get(n)!.delete(a);
              writes.get(a)!.drop.add(n);
            }
          }
          for (const [n, agents] of enable) {
            const s = find(n)!;
            if (confirmed.get(n) !== mcpSummary(s)) continue;
            const live = toLive(s, readValues(n));
            for (const a of agents) {
              if (!(planned.enable.get(n) ?? []).includes(a)) continue;
              nextAgents.get(n)!.add(a);
              writes.get(a)!.put.set(n, live);
            }
          }
          doc = { servers: doc.servers.map((s) => ({ ...s, agents: MCP_AGENT_IDS.filter((a) => nextAgents.get(s.name)!.has(a)) })) };
          persist();
          applyToAgents(writes);
        },
      };
    },

    /**
     * Adopt a server already in an agent's config into the library, enabled for that agent.
     * Nothing is written to any agent file, so no confirmation: the spec is the user's own.
     */
    import(agentId: McpAgentId, name: string): McpSnapshot {
      if (find(name)) throwIpcError('ALREADY_EXISTS', 'a server with this name exists');
      if (doc.servers.length >= MCP_LIMITS.maxServers) throwIpcError('PRECONDITION_FAILED', 'too many servers');
      const r = readAgentMcp(agentId);
      const live = r.state === 'ok' ? r.servers.get(name) : undefined;
      if (!live) throwIpcError('NOT_FOUND', 'server not found in agent config');
      const tooBig =
        (live.command?.length ?? 0) > MCP_LIMITS.maxCommand ||
        (live.args?.length ?? 0) > MCP_LIMITS.maxArgs ||
        (live.url?.length ?? 0) > MCP_LIMITS.maxUrl ||
        Object.keys(live.env).length + Object.keys(live.headers).length > MCP_LIMITS.maxVars;
      if (tooBig) throwIpcError('INVALID_PARAMS', 'server spec exceeds limits');
      const values: Values = { env: { ...live.env }, headers: { ...live.headers } };
      writeValues(name, values);
      const s: LibraryServer = {
        name,
        transport: live.transport,
        ...(live.transport === 'stdio' ? { command: live.command, args: live.args ?? [] } : { url: live.url }),
        envKeys: Object.keys(live.env),
        headerKeys: Object.keys(live.headers),
        agents: [agentId],
      };
      doc = { servers: [...doc.servers, s] };
      persist();
      log.info('mcp.imported', { agentId });
      return this.snapshot();
    },
  };
}

export type McpStore = ReturnType<typeof createMcpStore>;

/** Per agent, the library servers enabled for it — what a config profile records. */
export type McpEnabledSets = Partial<Record<McpAgentId, string[]>>;

/** A profile's MCP change, confirmed before anything (bindings included) is applied. */
export interface McpEnabledSetsPlan {
  proceed: boolean;
  /** Names in the profile that are no longer in the library (or not supported by the agent). */
  skipped: number;
  /** Applies the confirmed change. Call only when `proceed`. */
  commit(): void;
}
