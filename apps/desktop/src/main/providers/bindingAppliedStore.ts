import fs from 'node:fs';
import path from 'node:path';
import { renameSyncWithRetry } from '../fsRetry';
import { readUtf8WithoutBom } from '../storeFile';
import type { AgentId } from '../../shared/aiProviders';

/** What AiOpt last wrote into an agent's on-disk config for a binding. */
export interface AppliedBindingRecord {
  baseUrl: string;
  modelId: string;
  /** Whether a proxy or API token was written into the agent config. */
  authTokenSet: boolean;
  appliedAt: number;
  /** Provider id last bound (used to locate `aiopt-<id>` entries in additive configs). */
  providerId?: string;
}

type AppliedDocument = Partial<Record<AgentId, AppliedBindingRecord>>;

export interface BindingAppliedPersistence {
  load(): unknown;
  save(doc: AppliedDocument): void;
}

function validRecord(raw: unknown): AppliedBindingRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.baseUrl !== 'string') return null;
  if (typeof o.modelId !== 'string') return null;
  if (typeof o.authTokenSet !== 'boolean') return null;
  if (typeof o.appliedAt !== 'number') return null;
  const providerId = typeof o.providerId === 'string' ? o.providerId : undefined;
  return {
    baseUrl: o.baseUrl,
    modelId: o.modelId,
    authTokenSet: o.authTokenSet,
    appliedAt: o.appliedAt,
    ...(providerId !== undefined ? { providerId } : {}),
  };
}

function loadDoc(raw: unknown): AppliedDocument {
  if (!raw || typeof raw !== 'object') return {};
  const out: AppliedDocument = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const rec = validRecord(value);
    if (rec) out[key as AgentId] = rec;
  }
  return out;
}

export function createBindingAppliedStore(persistence: BindingAppliedPersistence) {
  let doc = loadDoc(persistence.load());

  const persist = (): void => {
    persistence.save(doc);
  };

  return {
    get(agentId: AgentId): AppliedBindingRecord | null {
      return doc[agentId] ?? null;
    },

    set(agentId: AgentId, record: Omit<AppliedBindingRecord, 'appliedAt'>): void {
      doc = {
        ...doc,
        [agentId]: { ...record, appliedAt: Date.now() },
      };
      persist();
    },

    clear(agentId: AgentId): void {
      if (!doc[agentId]) return;
      const next = { ...doc };
      delete next[agentId];
      doc = next;
      persist();
    },
  };
}

export type BindingAppliedStore = ReturnType<typeof createBindingAppliedStore>;

export function createFileBindingAppliedPersistence(filePath: string): BindingAppliedPersistence {
  return {
    load() {
      try {
        const text = readUtf8WithoutBom(filePath);
        if (text.trim() === '') return {};
        return JSON.parse(text) as unknown;
      } catch {
        return {};
      }
    },
    save(doc) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      renameSyncWithRetry(tmp, filePath);
    },
  };
}
