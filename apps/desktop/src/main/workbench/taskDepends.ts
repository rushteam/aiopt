// Task dependency helpers — pure, shared by the manager and unit tests.
//
// Dependencies are edges task → dependsOn (must complete before launch). The graph must stay
// acyclic; only `done` satisfies a dependency.

import { isValidWorkbenchId, type TaskStatus } from '../../shared/workbench';

/** Max outgoing dependency edges per task (matches propose_tasks batch size). */
export const MAX_DEPENDS_ON = 10;

export function normalizeDependsOnIds(raw: unknown, knownIds: ReadonlySet<string>, selfId?: string): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const id of raw) {
    if (out.length >= MAX_DEPENDS_ON) break;
    if (!isValidWorkbenchId(id) || id === selfId || !knownIds.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

export function dependenciesMet(
  dependsOn: readonly string[],
  tasks: ReadonlyMap<string, { status: TaskStatus }>,
): boolean {
  for (const id of dependsOn) {
    const dep = tasks.get(id);
    if (!dep || dep.status !== 'done') return false;
  }
  return true;
}

/** Whether adding `dependsOn` on `taskId` would create a cycle. */
export function wouldCreateCycle(
  taskId: string,
  dependsOn: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): boolean {
  const next = new Map<string, string[]>();
  for (const [k, v] of edges) next.set(k, [...v]);
  next.set(taskId, [...dependsOn]);

  function reaches(from: string, target: string, seen: Set<string>): boolean {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const dep of next.get(from) ?? []) {
      if (reaches(dep, target, seen)) return true;
    }
    return false;
  }

  for (const dep of dependsOn) {
    if (dep === taskId) return true;
    if (reaches(dep, taskId, new Set())) return true;
  }
  return false;
}
