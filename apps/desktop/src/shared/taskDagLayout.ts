// Layered layout for workbench task dependencies (DAG). Pure — no DOM.

import type { TaskStatus, TaskView } from './workbench';

export interface TaskDagNodeLayout {
  id: string;
  title: string;
  status: TaskStatus;
  layer: number;
  indexInLayer: number;
}

export interface TaskDagEdge {
  fromId: string;
  toId: string;
}

export interface TaskDagLayout {
  nodes: TaskDagNodeLayout[];
  edges: TaskDagEdge[];
  layerCount: number;
  maxWidth: number;
}

/** Assign each task to a layer (longest path from roots). Cycles are grouped in layer 0. */
export function layoutTaskDag(tasks: readonly TaskView[]): TaskDagLayout {
  if (tasks.length === 0) return { nodes: [], edges: [], layerCount: 0, maxWidth: 0 };

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const edges: TaskDagEdge[] = [];
  for (const t of tasks) {
    for (const depId of t.dependsOn) {
      if (byId.has(depId)) edges.push({ fromId: depId, toId: t.id });
    }
  }

  const layer = new Map<string, number>();
  for (const t of tasks) layer.set(t.id, 0);

  let changed = true;
  let guard = tasks.length * tasks.length + 1;
  while (changed && guard-- > 0) {
    changed = false;
    for (const t of tasks) {
      let maxDep = -1;
      for (const depId of t.dependsOn) {
        if (!byId.has(depId)) continue;
        maxDep = Math.max(maxDep, layer.get(depId) ?? 0);
      }
      if (maxDep < 0) continue;
      const next = maxDep + 1;
      if ((layer.get(t.id) ?? 0) < next) {
        layer.set(t.id, next);
        changed = true;
      }
    }
  }

  const buckets = new Map<number, TaskView[]>();
  for (const t of tasks) {
    const L = layer.get(t.id) ?? 0;
    const list = buckets.get(L) ?? [];
    list.push(t);
    buckets.set(L, list);
  }

  const layerCount = buckets.size === 0 ? 0 : Math.max(...buckets.keys()) + 1;
  let maxWidth = 0;
  const nodes: TaskDagNodeLayout[] = [];

  for (let L = 0; L < layerCount; L += 1) {
    const row = (buckets.get(L) ?? []).sort((a, b) => a.createdAt - b.createdAt || a.title.localeCompare(b.title));
    maxWidth = Math.max(maxWidth, row.length);
    row.forEach((t, indexInLayer) => {
      nodes.push({ id: t.id, title: t.title, status: t.status, layer: L, indexInLayer });
    });
  }

  return { nodes, edges, layerCount, maxWidth };
}
