// Persisted identity for the translation proxy — the fixed loopback port + the live
// per-binding route tokens.
//
// Same discipline as providerStore.ts: persistence is injected (Electron-free, unit
// testable), and on load every record is validated one-by-one with corrupt entries
// DROPPED (fail-closed) so a hand-mangled file can never wedge startup.
//
// SECURITY (see docs/dev-rules/credentials-and-local-storage.md): a route token is
// class-secret but NOT the real provider key — the real key always lives in the OS
// secret store and is resolved main-side at request time. The token is already written
// in plaintext into the agent's own config, so persisting it here (under `userData`,
// never the repo) does not widen its exposure. It deliberately trades the old "token
// dies on restart" property for a stable identity a restarted agent can keep using.
// Tokens must never reach a log or an IPC error (the proxy logs path/status/bytes only).

import fs from 'node:fs';
import path from 'node:path';
import { AGENT_IDS, API_FORMATS, type ApiFormat } from '../../shared/aiProviders';
import type { RouteSpec } from './router';

/** One persisted route: the token an agent holds + the spec it resolves to. */
export interface PersistedRoute {
  token: string;
  spec: RouteSpec;
}

/** The whole persisted proxy identity: the listen port (null until first bound) + routes. */
export interface ProxyStateDoc {
  port: number | null;
  routes: PersistedRoute[];
}

/** Persistence of the whole document. Production writes JSON atomically; tests inject memory. */
export interface ProxyStatePersistence {
  /** Raw parsed contents (any shape); the store validates it. */
  load(): unknown;
  save(doc: ProxyStateDoc): void;
}

export interface ProxyStateStore {
  /** The persisted listen port, or null when none is recorded / it is out of range. */
  loadPort(): number | null;
  savePort(port: number): void;
  /** The persisted routes (validated; corrupt entries already dropped). */
  loadRoutes(): PersistedRoute[];
  saveRoutes(routes: PersistedRoute[]): void;
}

// --- validation of untrusted persisted values -----------------------------

/** A TCP port an unprivileged process may bind: 1024–65535, else treat as unset. */
function validPort(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  if (raw < 1024 || raw > 65535) return null;
  return raw;
}

function nonEmptyString(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.trim() !== '';
}

function validSpec(raw: unknown): RouteSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!AGENT_IDS.includes(obj.agentId as never)) return null;
  if (!nonEmptyString(obj.providerId)) return null;
  if (!API_FORMATS.includes(obj.inboundFormat as ApiFormat)) return null;
  if (!API_FORMATS.includes(obj.outboundFormat as ApiFormat)) return null;
  if (!nonEmptyString(obj.upstreamBaseUrl)) return null;
  if (!nonEmptyString(obj.modelId)) return null;
  return {
    agentId: obj.agentId as RouteSpec['agentId'],
    providerId: obj.providerId,
    inboundFormat: obj.inboundFormat as ApiFormat,
    outboundFormat: obj.outboundFormat as ApiFormat,
    upstreamBaseUrl: obj.upstreamBaseUrl,
    modelId: obj.modelId,
  };
}

function validRoute(raw: unknown): PersistedRoute | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!nonEmptyString(obj.token)) return null;
  const spec = validSpec(obj.spec);
  if (!spec) return null;
  return { token: obj.token, spec };
}

function parseDocument(raw: unknown): ProxyStateDoc {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const port = validPort(obj.port);
  const routes: PersistedRoute[] = [];
  const seenTokens = new Set<string>();
  const seenAgents = new Set<string>();
  if (Array.isArray(obj.routes)) {
    for (const entry of obj.routes) {
      const route = validRoute(entry);
      // One live route per agent, one spec per token — drop collisions (the router keeps
      // the same invariant in memory, so a duplicated on-disk entry can only be corruption).
      if (route && !seenTokens.has(route.token) && !seenAgents.has(route.spec.agentId)) {
        seenTokens.add(route.token);
        seenAgents.add(route.spec.agentId);
        routes.push(route);
      }
    }
  }
  return { port, routes };
}

export function createProxyStateStore(persistence: ProxyStatePersistence): ProxyStateStore {
  const doc = parseDocument(persistence.load());
  let port = doc.port;
  let routes = doc.routes;

  function persist(): void {
    persistence.save({ port, routes });
  }

  return {
    loadPort: () => port,
    savePort(next) {
      port = next;
      persist();
    },
    loadRoutes: () => routes.map((r) => ({ token: r.token, spec: { ...r.spec } })),
    saveRoutes(next) {
      routes = next.map((r) => ({ token: r.token, spec: { ...r.spec } }));
      persist();
    },
  };
}

/**
 * File-backed persistence for the proxy state (versioned wrapper). Node-only (no
 * Electron), so it tests against a tmp dir; production points it at `userData/proxy.json`
 * (see main/paths.ts). Writes are atomic (temp+rename); a missing or corrupt file loads
 * as an empty document rather than throwing.
 */
export function createFileProxyStatePersistence(filePath: string): ProxyStatePersistence {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      } catch {
        return {};
      }
    },
    save(doc) {
      const tmp = `${filePath}.tmp`;
      const contents = `${JSON.stringify({ version: 1, ...doc }, null, 2)}\n`;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      try {
        fs.writeFileSync(tmp, contents, 'utf8');
        fs.renameSync(tmp, filePath);
      } catch (err) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // Best-effort cleanup; preserve the original write error.
        }
        throw err;
      }
    },
  };
}
