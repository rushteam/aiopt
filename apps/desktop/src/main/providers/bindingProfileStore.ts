import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { renameSyncWithRetry } from '../fsRetry';
import { readUtf8WithoutBom } from '../storeFile';
import {
  AGENT_IDS,
  type AgentBinding,
  type AgentId,
} from '../../shared/aiProviders';
import type { BindingProfile, BindingProfileSummary } from '../../shared/bindingProfiles';
import { throwIpcError } from '../ipc/validate';

interface ProfilesDocument {
  profiles: BindingProfile[];
}

export interface BindingProfilePersistence {
  load(): unknown;
  save(doc: ProfilesDocument): void;
}

function validBinding(raw: unknown): AgentBinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.providerId !== 'string' || o.providerId.trim() === '') return null;
  if (typeof o.modelId !== 'string' || o.modelId.trim() === '') return null;
  return { providerId: o.providerId, modelId: o.modelId };
}

function validProfile(raw: unknown): BindingProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.trim() === '') return null;
  if (typeof o.name !== 'string' || o.name.trim() === '') return null;
  if (typeof o.createdAt !== 'number') return null;
  if (!o.bindings || typeof o.bindings !== 'object') return null;
  const bindings: Partial<Record<AgentId, AgentBinding>> = {};
  for (const agentId of AGENT_IDS) {
    const b = validBinding((o.bindings as Record<string, unknown>)[agentId]);
    if (b) bindings[agentId] = b;
  }
  return { id: o.id, name: o.name.trim(), createdAt: o.createdAt, bindings };
}

function loadDoc(raw: unknown): ProfilesDocument {
  if (!raw || typeof raw !== 'object') return { profiles: [] };
  const profilesRaw = (raw as { profiles?: unknown }).profiles;
  if (!Array.isArray(profilesRaw)) return { profiles: [] };
  const profiles = profilesRaw.map(validProfile).filter((p): p is BindingProfile => p !== null);
  return { profiles };
}

export function createBindingProfileStore(persistence: BindingProfilePersistence) {
  let doc = loadDoc(persistence.load());

  const persist = (): void => {
    persistence.save(doc);
  };

  return {
    list(): BindingProfileSummary[] {
      return doc.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt,
        boundCount: Object.keys(p.bindings).length,
      }));
    },

    get(id: string): BindingProfile | null {
      return doc.profiles.find((p) => p.id === id) ?? null;
    },

    saveFromBindings(name: string, bindings: Partial<Record<AgentId, AgentBinding>>): BindingProfile {
      const trimmed = name.trim();
      if (trimmed === '') throwIpcError('INVALID_PARAMS', 'profile name is required');
      const profile: BindingProfile = {
        id: randomUUID(),
        name: trimmed,
        createdAt: Date.now(),
        bindings: { ...bindings },
      };
      doc = { profiles: [...doc.profiles, profile] };
      persist();
      return profile;
    },

    remove(id: string): void {
      const next = doc.profiles.filter((p) => p.id !== id);
      if (next.length === doc.profiles.length) throwIpcError('NOT_FOUND', 'profile not found');
      doc = { profiles: next };
      persist();
    },
  };
}

export type BindingProfileStore = ReturnType<typeof createBindingProfileStore>;

export function createFileBindingProfilePersistence(filePath: string): BindingProfilePersistence {
  return {
    load() {
      try {
        const text = readUtf8WithoutBom(filePath);
        if (text.trim() === '') return { profiles: [] };
        return JSON.parse(text) as unknown;
      } catch {
        return { profiles: [] };
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
