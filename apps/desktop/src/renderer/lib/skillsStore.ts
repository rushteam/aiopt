// Renderer-side skills store — the single copy of the skills sync matrix the whole
// renderer reads.
//
// Mirrors usageStore's shape: the snapshot is fetched asynchronously via
// `skills.get()` on first use, then kept in step by the throttled `skills:changed`
// push from main. Every mutation (pull/push/import/delete) returns the fresh
// snapshot, which is applied immediately; the broadcast echo re-applies it
// (idempotent) for other windows. Callers refer to a skill ONLY by symbolic
// coordinates (agentId + name) — never a path.

import type {
  SkillDiffResult,
  SkillFileContent,
  SkillRevealRef,
  SkillScope,
  SkillsLibraryLocation,
  SkillsSnapshot,
} from '../../shared/skills';
import type { AgentId } from '../../shared/aiProviders';

type Listener = () => void;

const EMPTY: SkillsSnapshot = {
  libraryLocation: 'app',
  centralPath: '',
  agents: [],
  rows: [],
  scannedAt: 0,
};

let snapshot: SkillsSnapshot = EMPTY;
let version = 0;
let initialized = false;
const listeners = new Set<Listener>();

function applySnapshot(next: SkillsSnapshot): void {
  snapshot = next;
  version += 1;
  listeners.forEach((listener) => listener());
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  // Track sync-matrix changes pushed from main (throttled rescans).
  window.aiopt.skills.onChanged(applySnapshot);
  void window.aiopt.skills.get().then(applySnapshot);
}

/** Subscribe to store changes; returns an unsubscribe fn. */
export function subscribeSkillsStore(listener: Listener): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Monotonic version for `useSyncExternalStore` getSnapshot — bumps on every change. */
export function getSkillsStoreVersion(): number {
  ensureInitialized();
  return version;
}

export function getSkillsSnapshot(): SkillsSnapshot {
  ensureInitialized();
  return snapshot;
}

/** Re-scan the central library + agent dirs (e.g. after switching the library location). */
export async function refreshSkills(): Promise<void> {
  ensureInitialized();
  applySnapshot(await window.aiopt.skills.get());
}

/** Pull an agent's copy of a skill into the central library. */
export async function pullSkill(agentId: AgentId, name: string): Promise<void> {
  ensureInitialized();
  applySnapshot(await window.aiopt.skills.pull(agentId, name));
}

/** Push the central copy of a skill out to one or more agents. */
export async function pushSkill(name: string, agentIds: AgentId[]): Promise<void> {
  ensureInitialized();
  applySnapshot(await window.aiopt.skills.push(name, agentIds));
}

/** Open a folder picker (main-side) and import the chosen skill; returns its name, or null if cancelled. */
export async function importSkill(): Promise<string | null> {
  ensureInitialized();
  const { snapshot: next, imported } = await window.aiopt.skills.import();
  applySnapshot(next);
  return imported;
}

/** Delete a skill from the central library (destructive; the caller confirms first). */
export async function deleteSkill(name: string): Promise<void> {
  ensureInitialized();
  applySnapshot(await window.aiopt.skills.delete(name));
}

/** Delete an agent's own copy of a skill (destructive; the caller confirms first). */
export async function deleteAgentSkill(agentId: AgentId, name: string): Promise<void> {
  ensureInitialized();
  applySnapshot(await window.aiopt.skills.deleteAgent(agentId, name));
}

/** Per-file diff of an agent's copy against the central copy (metadata only). */
export function diffSkill(agentId: AgentId, name: string): Promise<SkillDiffResult> {
  ensureInitialized();
  return window.aiopt.skills.diff(agentId, name);
}

/** Read one differing file's content (from a side) for the diff preview; text/size-capped. */
export function skillFileContent(
  agentId: AgentId,
  name: string,
  side: SkillScope,
  relPath: string,
): Promise<SkillFileContent> {
  ensureInitialized();
  return window.aiopt.skills.fileContent(agentId, name, side, relPath);
}

/**
 * Merge a differing skill back into the central library, taking `agentPicks` (the
 * relPaths picked from the agent side) from the agent; everything else keeps the
 * central version. Destructive to CENTRAL only — the caller confirms first.
 */
export async function mergeSkill(
  agentId: AgentId,
  name: string,
  agentPicks: string[],
): Promise<void> {
  ensureInitialized();
  applySnapshot(await window.aiopt.skills.merge(agentId, name, agentPicks));
}

/** Open a skills location in the OS file manager (main resolves + allowlists the path). */
export function revealSkill(ref: SkillRevealRef): Promise<Record<string, never>> {
  ensureInitialized();
  return window.aiopt.skills.reveal(ref);
}

/** Switch where the central library points, then rescan. Content is not migrated (v1). */
export async function setLibraryLocation(location: SkillsLibraryLocation): Promise<void> {
  ensureInitialized();
  await window.aiopt.config.set('skillsLibrary', location);
  await refreshSkills();
}
