// The MCP server library and its sync with each agent's own MCP config — the same model as
// skills: the snapshot is a live comparison of the library against every agent file, and
// nothing moves between them unless the user pulls, pushes, merges or deletes.
//
// Library (userData/mcp-servers.json): name, transport, command/args or url, and env/header
// KEYS. Values: one main-only secret per server (`main_mcp_<hex name>`) holding
// `{ env, headers }`. The renderer never sees a value.
//
// Library edits, pulls, merges and library deletes never touch an agent file. A push puts a
// spec into an agent file, so it is confirmed first through the injected `confirmWrite` — a
// main-side native dialog the renderer cannot answer. Deleting an agent's entry only removes.

import { readUtf8WithoutBom, writeFileAtomicSync } from '../storeFile';
import { throwIpcError } from '../ipc/validate';
import { MAIN_ONLY_SECRET_PREFIX, type SecretStore } from '../secrets/secretStore';
import { logger } from '../logger';
import {
  MCP_AGENT_IDS,
  MCP_ENV_KEY_RE,
  MCP_HEADER_KEY_RE,
  MCP_LIMITS,
  agentAcceptsServer,
  agentNamesRemoteTransport,
  isMcpName,
  mcpSummary,
  type McpAgentId,
  type McpAgentEntry,
  type McpAgentInfo,
  type McpCell,
  type McpDiffResult,
  type McpFieldDiff,
  type McpMatrixRow,
  type McpSaveRequest,
  type McpServerShape,
  type McpServerView,
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
  const base = { name: o.name, envKeys: strings(o.envKeys), headerKeys: strings(o.headerKeys) };
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

/** Only Claude and Gemini files say SSE; elsewhere every remote entry reads back as `http`. */
function liveTransportFor(agentId: McpAgentId, s: LiveMcpServer): LiveMcpServer {
  return !agentNamesRemoteTransport(agentId) && s.transport !== 'stdio' ? { ...s, transport: 'http' } : s;
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

  const assertSecretsFor = (v: Values): void => {
    if (Object.keys(v.env).length + Object.keys(v.headers).length > 0 && !deps.secrets.isAvailable()) {
      throwIpcError('PRECONDITION_FAILED', 'OS secret encryption is unavailable');
    }
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

  /** The agent's live entry, or NOT_FOUND. Unreadable files are PRECONDITION_FAILED. */
  const agentEntry = (agentId: McpAgentId, name: string): LiveMcpServer => {
    const r = readAgentMcp(agentId);
    if (r.state === 'unreadable') throwIpcError('PRECONDITION_FAILED', `${agentId} MCP config could not be read`);
    const live = r.servers.get(name);
    if (!live) throwIpcError('NOT_FOUND', 'server not found in agent config');
    return live;
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

  const view = (s: LibraryServer): McpServerView => {
    const values = readValues(s.name);
    return {
      name: s.name,
      transport: s.transport,
      ...(s.transport === 'stdio' ? { command: s.command, args: s.args } : { url: s.url }),
      env: s.envKeys.map((key) => ({ key, set: Object.hasOwn(values.env, key) })),
      headers: s.headerKeys.map((key) => ({ key, set: Object.hasOwn(values.headers, key) })),
    };
  };

  const entryView = (l: LiveMcpServer): McpAgentEntry => ({
    transport: l.transport,
    ...(l.transport === 'stdio' ? { command: l.command, args: l.args ?? [] } : { url: l.url }),
    envKeys: Object.keys(l.env),
    headerKeys: Object.keys(l.headers),
  });

  /** Library-known names present in each readable agent file (unreadable agents omitted). */
  const presentSets = (live: Record<McpAgentId, AgentMcpRead>): McpEnabledSets => {
    const out: McpEnabledSets = {};
    for (const a of MCP_AGENT_IDS) {
      const r = live[a];
      if (r.state === 'ok') out[a] = doc.servers.filter((s) => r.servers.has(s.name)).map((s) => s.name);
    }
    return out;
  };

  /** Every field that differs; empty when the two are the same server. */
  const fieldDiff = (agentId: McpAgentId, s: LibraryServer, got: LiveMcpServer): McpFieldDiff[] => {
    const want = liveTransportFor(agentId, toLive(s, readValues(s.name)));
    const fields: McpFieldDiff[] = [];
    const specSame =
      want.transport === got.transport &&
      (want.transport === 'stdio'
        ? want.command === got.command && JSON.stringify(want.args ?? []) === JSON.stringify(got.args ?? [])
        : want.url === got.url);
    if (!specSame) {
      fields.push({ field: 'spec', kind: 'spec', status: 'modified', library: mcpSummary(s), agent: mcpSummary(got) });
    }
    for (const [kind, a, b] of [
      ['env', want.env, got.env],
      ['header', want.headers, got.headers],
    ] as const) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys) {
        const inA = Object.hasOwn(a, key);
        const inB = Object.hasOwn(b, key);
        if (inA && inB && a[key] === b[key]) continue;
        fields.push({ field: `${kind}:${key}`, kind, key, status: inA && inB ? 'modified' : inA ? 'added' : 'deleted' });
      }
    }
    return fields;
  };

  const checkLimits = (live: LiveMcpServer): void => {
    const tooBig =
      (live.command?.length ?? 0) > MCP_LIMITS.maxCommand ||
      (live.args?.length ?? 0) > MCP_LIMITS.maxArgs ||
      (live.args ?? []).some((a) => a.length > MCP_LIMITS.maxArg) ||
      (live.url?.length ?? 0) > MCP_LIMITS.maxUrl ||
      Object.keys(live.env).length + Object.keys(live.headers).length > MCP_LIMITS.maxVars ||
      [...Object.values(live.env), ...Object.values(live.headers)].some((v) => v.length > MCP_LIMITS.maxVarValue);
    if (tooBig) throwIpcError('INVALID_PARAMS', 'server spec exceeds limits');
  };

  /** Put a server into the library (replacing one of the same name) with its values. */
  const putLibrary = (next: LibraryServer, values: Values): void => {
    const existing = find(next.name);
    if (!existing && doc.servers.length >= MCP_LIMITS.maxServers) throwIpcError('PRECONDITION_FAILED', 'too many servers');
    assertSecretsFor(values);
    writeValues(next.name, values);
    doc = { servers: existing ? doc.servers.map((s) => (s.name === next.name ? next : s)) : [...doc.servers, next] };
    persist();
  };

  const fromLive = (name: string, live: LiveMcpServer): LibraryServer => ({
    name,
    transport: live.transport,
    ...(live.transport === 'stdio' ? { command: live.command, args: live.args ?? [] } : { url: live.url }),
    envKeys: Object.keys(live.env),
    headerKeys: Object.keys(live.headers),
  });

  return {
    snapshot(): McpSnapshot {
      const live = readAll();
      const names = new Set(doc.servers.map((s) => s.name));
      for (const a of MCP_AGENT_IDS) {
        const r = live[a];
        if (r.state === 'ok') for (const n of r.servers.keys()) if (isMcpName(n)) names.add(n);
      }
      const rows: McpMatrixRow[] = [...names].sort((x, y) => x.localeCompare(y)).map((name) => {
        const s = find(name);
        const want = s ? toLive(s, readValues(name)) : null;
        const agents: Partial<Record<McpAgentId, McpCell>> = {};
        for (const a of MCP_AGENT_IDS) {
          const r = live[a];
          if (r.state !== 'ok') continue;
          const got = r.servers.get(name);
          const supported = s ? agentAcceptsServer(a, s.name, s.transport) : true;
          if (s && got) {
            const same = sameMcpServer(liveTransportFor(a, want!), got);
            agents[a] = { state: same ? 'same' : 'differs', entry: entryView(got), supported };
          } else if (s) agents[a] = { state: 'library-only', entry: null, supported };
          else if (got) agents[a] = { state: 'agent-only', entry: entryView(got), supported };
        }
        return { name, library: s ? view(s) : null, agents };
      });
      const agents: McpAgentInfo[] = MCP_AGENT_IDS.map((agentId) => ({
        agentId,
        installed: deps.isInstalled(agentId),
        configDisplayPath: deps.displayPath(mcpConfigPath(agentId)),
        unreadable: live[agentId].state === 'unreadable',
      }));
      return { rows, agents, secretsAvailable: deps.secrets.isAvailable() };
    },

    /**
     * GATED: one stored env / header value in plaintext, for the edit form's reveal button.
     * Deliberately one value per call (no bulk export). Never log the result. Null when the
     * server is unknown or the key has no stored value.
     */
    revealValue(name: string, kind: 'env' | 'header', key: string): string | null {
      if (!find(name)) return null;
      const values = readValues(name);
      const map = kind === 'env' ? values.env : values.headers;
      return Object.hasOwn(map, key) && typeof map[key] === 'string' ? map[key]! : null;
    },

    /** Add or edit a library server. Agent files are not touched; they show `differs` until pushed. */
    save(req: McpSaveRequest): McpSnapshot {
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
      };
      assertSecretsFor(values);
      writeValues(next.name, values);
      if (previous && previous.name !== next.name) deps.secrets.delete(secretKey(previous.name));
      doc = {
        servers: previous ? doc.servers.map((s) => (s.name === previous.name ? next : s)) : [...doc.servers, next],
      };
      persist();
      return this.snapshot();
    },

    /**
     * Copy an agent's entry into the library (creating or overwriting it), values into the
     * secret store. No agent file is written, so no confirmation: the spec is the user's own.
     */
    pull(agentId: McpAgentId, name: string): McpSnapshot {
      const live = agentEntry(agentId, name);
      checkLimits(live);
      putLibrary(fromLive(name, live), { env: { ...live.env }, headers: { ...live.headers } });
      log.info('mcp.pulled', { agentId });
      return this.snapshot();
    },

    /**
     * Write the library spec into the given agents, overwriting their entry. One native
     * confirmation lists every agent; what is written is exactly what the dialog showed.
     */
    async push(name: string, agentIds: McpAgentId[]): Promise<McpWriteResult> {
      const s = find(name);
      if (!s) throwIpcError('NOT_FOUND', 'server not found');
      for (const a of agentIds) {
        if (!agentAcceptsServer(a, s.name, s.transport)) {
          throwIpcError('UNSUPPORTED_CAPABILITY', `${a} cannot take this ${s.transport} server`);
        }
      }
      assertWritable(agentIds);
      const live = toLive(s, readValues(name));
      if (!(await deps.confirmWrite([confirmFor(s, agentIds)]))) return { saved: false, snapshot: this.snapshot() };
      const writes = emptyWrites();
      for (const a of agentIds) writes.get(a)!.put.set(name, live);
      applyToAgents(writes);
      return { saved: true, snapshot: this.snapshot() };
    },

    /** Remove a server from the library and its values. Agent files are left as they are. */
    remove(name: string): McpSnapshot {
      if (!find(name)) throwIpcError('NOT_FOUND', 'server not found');
      doc = { servers: doc.servers.filter((x) => x.name !== name) };
      persist();
      deps.secrets.delete(secretKey(name));
      return this.snapshot();
    },

    /** Remove one agent's entry. The library and other agents are left as they are. */
    removeFromAgent(agentId: McpAgentId, name: string): McpSnapshot {
      agentEntry(agentId, name);
      const writes = emptyWrites();
      writes.get(agentId)!.drop.add(name);
      applyToAgents(writes);
      return this.snapshot();
    },

    /** Which fields differ between the library and one agent. Values are never included. */
    diff(agentId: McpAgentId, name: string): McpDiffResult {
      const s = find(name);
      if (!s) throwIpcError('NOT_FOUND', 'server not found');
      return { agentId, name, fields: fieldDiff(agentId, s, agentEntry(agentId, name)) };
    },

    /**
     * Take the picked fields from the agent into the library; the rest keep the library
     * version. Only the library changes. Picks not in the current diff are dropped.
     */
    merge(agentId: McpAgentId, name: string, agentPicks: string[]): McpSnapshot {
      const s = find(name);
      if (!s) throwIpcError('NOT_FOUND', 'server not found');
      const got = agentEntry(agentId, name);
      const known = new Set(fieldDiff(agentId, s, got).map((f) => f.field));
      const picks = new Set(agentPicks.filter((p) => known.has(p)));
      if (picks.size === 0) return this.snapshot();
      const values = readValues(name);
      const env = pick(values.env, s.envKeys);
      const headers = pick(values.headers, s.headerKeys);
      const envKeys = [...s.envKeys];
      const headerKeys = [...s.headerKeys];
      for (const [prefix, map, keys, from] of [
        ['env:', env, envKeys, got.env],
        ['header:', headers, headerKeys, got.headers],
      ] as const) {
        for (const p of picks) {
          if (!p.startsWith(prefix)) continue;
          const key = p.slice(prefix.length);
          if (Object.hasOwn(from, key)) {
            map[key] = from[key]!;
            if (!keys.includes(key)) keys.push(key);
          } else {
            delete map[key];
            keys.splice(keys.indexOf(key), 1);
          }
        }
      }
      const spec: McpServerShape = picks.has('spec')
        ? got.transport === 'stdio'
          ? { transport: 'stdio', command: got.command, args: got.args ?? [] }
          : // Files that store only a `url` read every remote server back as http; keep the
            // library's SSE choice there.
            {
              transport: !agentNamesRemoteTransport(agentId) && s.transport === 'sse' ? 'sse' : got.transport,
              url: got.url,
            }
        : s.transport === 'stdio'
          ? { transport: 'stdio', command: s.command, args: s.args ?? [] }
          : { transport: s.transport, url: s.url };
      // Env belongs to a command, headers to a connection: drop what the transport cannot carry.
      const stdio = spec.transport === 'stdio';
      const next: LibraryServer = { name, ...spec, envKeys: stdio ? envKeys : [], headerKeys: stdio ? [] : headerKeys };
      checkLimits(toLive(next, { env, headers }));
      putLibrary(next, { env: stdio ? env : {}, headers: stdio ? {} : headers });
      log.info('mcp.merged', { agentId, fields: picks.size });
      return this.snapshot();
    },

    /** Per agent, the library servers its file has — what a config profile records. */
    enabledSets(): McpEnabledSets {
      return presentSets(readAll());
    },

    /**
     * Plan making each agent's library servers equal the given sets (agents absent from
     * `sets` are left alone). Only library-known names are ever added or removed — an entry
     * the user wrote by hand into an agent file is never touched. Adding writes commands into
     * agent files, so a non-empty add list goes through ONE confirmation; removing needs none.
     * Unreadable target files refuse the whole plan before the dialog.
     */
    async planEnabledSets(sets: McpEnabledSets): Promise<McpEnabledSetsPlan> {
      const diff = () => {
        const present = presentSets(readAll());
        const add = new Map<string, McpAgentId[]>();
        const drop = new Map<string, McpAgentId[]>();
        let skipped = 0;
        for (const a of MCP_AGENT_IDS) {
          const want = sets[a];
          if (!want) continue;
          const wanted = new Set(want);
          for (const n of wanted) {
            const s = find(n);
            if (!s || !agentAcceptsServer(a, s.name, s.transport)) skipped += 1;
          }
          const has = new Set(present[a] ?? []);
          for (const s of doc.servers) {
            const should = wanted.has(s.name) && agentAcceptsServer(a, s.name, s.transport);
            const into = should && !has.has(s.name) ? add : !wanted.has(s.name) && has.has(s.name) ? drop : null;
            if (into) into.set(s.name, [...(into.get(s.name) ?? []), a]);
          }
        }
        return { add, drop, skipped };
      };
      const touched = new Set<McpAgentId>();
      for (const a of MCP_AGENT_IDS) if (sets[a]) touched.add(a);
      assertWritable(touched);
      const planned = diff();
      // What the user saw: name → spec summary, so a spec edited during the dialog is not written.
      const confirmed = new Map<string, string>();
      if (planned.add.size > 0) {
        const reqs = [...planned.add].map(([n, agents]) => confirmFor(find(n)!, agents));
        if (!(await deps.confirmWrite(reqs))) return { proceed: false, skipped: planned.skipped, commit: () => {} };
        for (const r of reqs) confirmed.set(r.name, r.summary);
      }
      return {
        proceed: true,
        skipped: planned.skipped,
        commit: () => {
          const { add, drop } = diff();
          const writes = emptyWrites();
          for (const [n, agents] of drop) for (const a of agents) writes.get(a)!.drop.add(n);
          for (const [n, agents] of add) {
            const s = find(n)!;
            if (confirmed.get(n) !== mcpSummary(s)) continue;
            const live = toLive(s, readValues(n));
            for (const a of agents) if ((planned.add.get(n) ?? []).includes(a)) writes.get(a)!.put.set(n, live);
          }
          applyToAgents(writes);
        },
      };
    },
  };
}

export type McpStore = ReturnType<typeof createMcpStore>;

/** Per agent, the library servers present in its file — what a config profile records. */
export type McpEnabledSets = Partial<Record<McpAgentId, string[]>>;

/** A profile's MCP change, confirmed before anything (bindings included) is applied. */
export interface McpEnabledSetsPlan {
  proceed: boolean;
  /** Names in the profile that are no longer in the library (or not supported by the agent). */
  skipped: number;
  /** Applies the confirmed change. Call only when `proceed`. */
  commit(): void;
}
