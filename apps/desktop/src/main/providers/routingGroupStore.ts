// Routing-group document store — user-defined failover pools on disk.
//
// Same discipline as providerStore: injected persistence, fail-closed validation,
// atomic writes. Groups are NOT providers: they live in their own file so a
// mangled group cannot drop the provider pool, and vice versa.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { renameSyncWithRetry } from '../fsRetry';
import { readUtf8WithoutBom } from '../storeFile';
import { throwIpcError } from '../ipc/validate';
import {
  ROUTING_AFFINITIES,
  ROUTING_STRATEGIES,
  routingGroupVirtualId,
  type RoutingAffinity,
  type RoutingGroup,
  type RoutingGroupMember,
  type RoutingGroupSummary,
  type RoutingStrategy,
} from '../../shared/routingGroups';

export interface RoutingGroupsDocument {
  groups: RoutingGroup[];
}

export interface RoutingGroupPersistence {
  load(): unknown;
  save(doc: RoutingGroupsDocument): void;
}

export interface RoutingGroupInput {
  name: string;
  members: RoutingGroupMember[];
  strategy?: RoutingStrategy;
  affinity?: RoutingAffinity;
}

export interface RoutingGroupStore {
  list(): RoutingGroup[];
  get(id: string): RoutingGroup | null;
  getByVirtualProviderId(virtualId: string): RoutingGroup | null;
  add(input: RoutingGroupInput): RoutingGroup;
  replace(id: string, input: RoutingGroupInput): RoutingGroup;
  remove(id: string): void;
  summaries(): RoutingGroupSummary[];
}

function validMember(raw: unknown): RoutingGroupMember | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.providerId !== 'string' || o.providerId.trim() === '') return null;
  if (typeof o.modelId !== 'string' || o.modelId.trim() === '') return null;
  return { providerId: o.providerId.trim(), modelId: o.modelId.trim() };
}

function validStrategy(raw: unknown): RoutingStrategy {
  return ROUTING_STRATEGIES.includes(raw as RoutingStrategy) ? (raw as RoutingStrategy) : 'ordered';
}

function validAffinity(raw: unknown): RoutingAffinity {
  return ROUTING_AFFINITIES.includes(raw as RoutingAffinity) ? (raw as RoutingAffinity) : 'session';
}

function validGroup(raw: unknown): RoutingGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.trim() === '') return null;
  if (typeof o.name !== 'string' || o.name.trim() === '') return null;
  if (!Array.isArray(o.members)) return null;
  const members = o.members.map(validMember).filter((m): m is RoutingGroupMember => m !== null);
  if (members.length === 0) return null;
  // De-dupe seats while keeping order.
  const seen = new Set<string>();
  const unique: RoutingGroupMember[] = [];
  for (const m of members) {
    const k = `${m.providerId}\0${m.modelId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(m);
  }
  if (unique.length === 0) return null;
  const createdAt = typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : 0;
  return {
    id: o.id.trim(),
    name: o.name.trim(),
    members: unique,
    strategy: validStrategy(o.strategy),
    affinity: validAffinity(o.affinity),
    createdAt,
  };
}

function parseDocument(raw: unknown): RoutingGroupsDocument {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const groups: RoutingGroup[] = [];
  const seen = new Set<string>();
  if (Array.isArray(obj.groups)) {
    for (const entry of obj.groups) {
      const g = validGroup(entry);
      if (g && !seen.has(g.id)) {
        seen.add(g.id);
        groups.push(g);
      }
    }
  }
  return { groups };
}

function normalizeInput(input: RoutingGroupInput): Omit<RoutingGroup, 'id' | 'createdAt'> {
  const name = input.name.trim();
  if (name === '') throwIpcError('INVALID_PARAMS', 'group name is required');
  if (!Array.isArray(input.members) || input.members.length === 0) {
    throwIpcError('INVALID_PARAMS', 'group needs at least one member');
  }
  const seen = new Set<string>();
  const members: RoutingGroupMember[] = [];
  for (const raw of input.members) {
    const m = validMember(raw);
    if (!m) throwIpcError('INVALID_PARAMS', 'invalid group member');
    const k = `${m.providerId}\0${m.modelId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    members.push(m);
  }
  if (members.length === 0) throwIpcError('INVALID_PARAMS', 'group needs at least one member');
  const strategy =
    input.strategy && ROUTING_STRATEGIES.includes(input.strategy) ? input.strategy : 'ordered';
  const affinity =
    input.affinity && ROUTING_AFFINITIES.includes(input.affinity) ? input.affinity : 'session';
  return { name, members, strategy, affinity };
}

export function createRoutingGroupStore(persistence: RoutingGroupPersistence): RoutingGroupStore {
  let doc = parseDocument(persistence.load());

  function persist(): void {
    persistence.save(doc);
  }

  return {
    list: () => doc.groups.map((g) => ({ ...g, members: g.members.map((m) => ({ ...m })) })),

    get(id) {
      const g = doc.groups.find((x) => x.id === id);
      return g ? { ...g, members: g.members.map((m) => ({ ...m })) } : null;
    },

    getByVirtualProviderId(virtualId) {
      const g = doc.groups.find((x) => routingGroupVirtualId(x.id) === virtualId);
      return g ? { ...g, members: g.members.map((m) => ({ ...m })) } : null;
    },

    add(input) {
      const body = normalizeInput(input);
      const group: RoutingGroup = {
        id: randomUUID(),
        createdAt: Date.now(),
        ...body,
      };
      doc = { groups: [...doc.groups, group] };
      persist();
      return { ...group, members: group.members.map((m) => ({ ...m })) };
    },

    replace(id, input) {
      const existing = doc.groups.find((g) => g.id === id);
      if (!existing) throwIpcError('NOT_FOUND', 'routing group not found');
      const body = normalizeInput(input);
      const group: RoutingGroup = { ...existing, ...body };
      doc = { groups: doc.groups.map((g) => (g.id === id ? group : g)) };
      persist();
      return { ...group, members: group.members.map((m) => ({ ...m })) };
    },

    remove(id) {
      if (!doc.groups.some((g) => g.id === id)) return;
      doc = { groups: doc.groups.filter((g) => g.id !== id) };
      persist();
    },

    summaries() {
      return doc.groups.map((g) => ({
        id: g.id,
        name: g.name,
        members: g.members.map((m) => ({ ...m })),
        strategy: g.strategy,
        affinity: g.affinity,
        createdAt: g.createdAt,
        virtualProviderId: routingGroupVirtualId(g.id),
      }));
    },
  };
}

export function createFileRoutingGroupPersistence(filePath: string): RoutingGroupPersistence {
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
      const contents = `${JSON.stringify({ version: 1, ...doc }, null, 2)}\n`;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      try {
        fs.writeFileSync(tmp, contents, 'utf8');
        renameSyncWithRetry(tmp, filePath);
      } catch (err) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // best-effort
        }
        throw err;
      }
    },
  };
}
