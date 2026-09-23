// Provider document store — the global pool + per-agent bindings on disk.
//
// Same discipline as configStore.ts: persistence is injected (Electron-free, unit
// testable), and on load every record is validated one-by-one with corrupt entries
// DROPPED (fail-closed) so a hand-mangled file can never wedge startup. API keys
// are never in this document — they live in the secret store; only the derived
// `hasKey` flag is ever surfaced (by the manager, not here).

import fs from 'node:fs';
import path from 'node:path';
import { renameSyncWithRetry } from '../fsRetry';
import { readUtf8WithoutBom } from '../storeFile';
import {
  AGENT_IDS,
  API_FORMATS,
  OFFICIAL_PROVIDER_ID_PREFIX,
  normalizeDropFields,
  type AgentBinding,
  type AgentId,
  type ApiFormat,
  type Provider,
  type ProviderModel,
} from '../../shared/aiProviders';
import { throwIpcError } from '../ipc/validate';

export interface ProvidersDocument {
  providers: Provider[];
  bindings: Partial<Record<AgentId, AgentBinding>>;
}

/** Persistence of the whole document. Production writes JSON atomically; tests inject memory. */
export interface ProviderPersistence {
  /** Raw parsed contents (any shape); the store validates it. */
  load(): unknown;
  save(doc: ProvidersDocument): void;
}

export interface ProviderStore {
  listProviders(): Provider[];
  getProvider(id: string): Provider | null;
  /** Insert a fully-formed provider; throws ALREADY_EXISTS on a duplicate id. */
  addProvider(provider: Provider): void;
  /** Replace an existing provider record; throws NOT_FOUND if absent. */
  replaceProvider(provider: Provider): void;
  /** Remove a provider and any binding pointing at it. */
  removeProvider(id: string): void;
  getBindings(): Partial<Record<AgentId, AgentBinding>>;
  getBinding(agentId: AgentId): AgentBinding | null;
  setBinding(agentId: AgentId, binding: AgentBinding): void;
  clearBinding(agentId: AgentId): void;
}

// --- validation of untrusted persisted values -----------------------------

function validModel(raw: unknown): ProviderModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.trim() === '') return null;
  const model: ProviderModel = { id: obj.id };
  if (typeof obj.alias === 'string' && obj.alias.trim() !== '') model.alias = obj.alias.trim();
  return model;
}

function validProvider(raw: unknown): Provider | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.trim() === '') return null;
  if (typeof obj.name !== 'string' || obj.name.trim() === '') return null;
  if (!API_FORMATS.includes(obj.apiFormat as ApiFormat)) return null;
  if (typeof obj.baseUrl !== 'string' || obj.baseUrl.trim() === '') return null;
  if (!Array.isArray(obj.models)) return null;
  const models = obj.models.map(validModel).filter((m): m is ProviderModel => m !== null);
  const provider: Provider = {
    id: obj.id,
    name: obj.name,
    apiFormat: obj.apiFormat as ApiFormat,
    baseUrl: obj.baseUrl,
    models,
    createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : 0,
  };
  if (typeof obj.notes === 'string' && obj.notes.trim() !== '') provider.notes = obj.notes;
  // Drop-fields: keep only names on the shared allowlist (normalizeDropFields discards
  // anything else, so a hand-edited file can't make the proxy strip `tools`), and omit the
  // key entirely when nothing survives — an empty array and "absent" mean the same thing,
  // and not writing it keeps untouched providers' records clean.
  if (Array.isArray(obj.dropRequestFields)) {
    const fields = normalizeDropFields(obj.dropRequestFields.filter((f): f is string => typeof f === 'string'));
    if (fields.length > 0) provider.dropRequestFields = fields;
  }
  return provider;
}

function validBinding(raw: unknown): AgentBinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.providerId !== 'string' || obj.providerId.trim() === '') return null;
  if (typeof obj.modelId !== 'string' || obj.modelId.trim() === '') return null;
  return { providerId: obj.providerId, modelId: obj.modelId };
}

function parseDocument(raw: unknown): ProvidersDocument {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const providers: Provider[] = [];
  const seen = new Set<string>();
  if (Array.isArray(obj.providers)) {
    for (const entry of obj.providers) {
      const provider = validProvider(entry);
      // The pool is user-curated: it never holds a preset ("official-") id. Presets
      // mint fresh UUIDs, so any such id can only be a leftover seeded by an older
      // build — drop it (bindings pointing at it then dangle and are pruned below).
      if (provider && !provider.id.startsWith(OFFICIAL_PROVIDER_ID_PREFIX) && !seen.has(provider.id)) {
        seen.add(provider.id);
        providers.push(provider);
      }
    }
  }

  const bindings: Partial<Record<AgentId, AgentBinding>> = {};
  const rawBindings =
    obj.bindings && typeof obj.bindings === 'object' && !Array.isArray(obj.bindings)
      ? (obj.bindings as Record<string, unknown>)
      : {};
  for (const agentId of AGENT_IDS) {
    const binding = validBinding(rawBindings[agentId]);
    // Drop a binding whose provider no longer exists (dangling pointer).
    if (binding && seen.has(binding.providerId)) bindings[agentId] = binding;
  }

  return { providers, bindings };
}

export function createProviderStore(persistence: ProviderPersistence): ProviderStore {
  const doc = parseDocument(persistence.load());
  const providers = new Map<string, Provider>(doc.providers.map((p) => [p.id, p]));
  let bindings = { ...doc.bindings };

  function persist(): void {
    persistence.save({
      providers: [...providers.values()],
      bindings: { ...bindings },
    });
  }

  return {
    listProviders: () => [...providers.values()],
    getProvider: (id) => providers.get(id) ?? null,

    addProvider(provider) {
      if (providers.has(provider.id)) throwIpcError('ALREADY_EXISTS', 'provider id already exists');
      providers.set(provider.id, provider);
      persist();
    },

    replaceProvider(provider) {
      if (!providers.has(provider.id)) throwIpcError('NOT_FOUND', 'provider not found');
      providers.set(provider.id, provider);
      persist();
    },

    removeProvider(id) {
      if (!providers.delete(id)) return;
      // Drop any binding that pointed at the removed provider.
      const next: Partial<Record<AgentId, AgentBinding>> = {};
      for (const agentId of AGENT_IDS) {
        const binding = bindings[agentId];
        if (binding && binding.providerId !== id) next[agentId] = binding;
      }
      bindings = next;
      persist();
    },

    getBindings: () => ({ ...bindings }),
    getBinding: (agentId) => bindings[agentId] ?? null,

    setBinding(agentId, binding) {
      bindings = { ...bindings, [agentId]: binding };
      persist();
    },

    clearBinding(agentId) {
      if (!bindings[agentId]) return;
      const next = { ...bindings };
      delete next[agentId];
      bindings = next;
      persist();
    },
  };
}

/**
 * File-backed persistence for the providers document (versioned wrapper). Node-only
 * (no Electron), so it tests against a tmp dir; production points it at
 * `userData/providers.json` (see main/paths.ts). Writes are atomic (temp+rename); a
 * missing or corrupt file loads as an empty document rather than throwing.
 */
export function createFileProviderPersistence(filePath: string): ProviderPersistence {
  return {
    load() {
      try {
        return JSON.parse(readUtf8WithoutBom(filePath)) as unknown;
      } catch {
        return {};
      }
    },
    save(doc) {
      const tmp = `${filePath}.tmp`;
      const contents = `${JSON.stringify({ version: 2, ...doc }, null, 2)}\n`;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      try {
        fs.writeFileSync(tmp, contents, 'utf8');
        renameSyncWithRetry(tmp, filePath);
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
