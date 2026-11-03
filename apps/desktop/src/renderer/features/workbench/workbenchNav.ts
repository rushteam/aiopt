// What the Workbench content area shows, and the pure helpers the sidebar and explorer use.

import { layoutTaskDag } from '../../../shared/taskDagLayout';
import type { TaskView } from '../../../shared/workbench';

/**
 * What the content area shows: the coordinator chat, the plan graph, one task (all sidebar
 * tabs), or a read-only preview of a file picked in the explorer.
 */
export type WorkbenchView =
  | { kind: 'chat' }
  | { kind: 'plan' }
  | { kind: 'task'; id: string }
  | { kind: 'file'; folderId: string; relPath: string };

export function viewKey(view: WorkbenchView): string {
  if (view.kind === 'task') return `task:${view.id}`;
  if (view.kind === 'file') return `file:${view.folderId}\u0000${view.relPath}`;
  return view.kind;
}

/** A preview's line-number gutter: `1\n2\n…` for `text` (a trailing newline adds no line). */
export function lineNumbers(text: string): string {
  if (text === '') return '1';
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1;
  if (text.endsWith('\n')) lines -= 1;
  return Array.from({ length: lines }, (_, i) => String(i + 1)).join('\n');
}

/** A byte count for display: `812 B`, `12.4 KB`, `3.1 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Deepest indent the sidebar draws for a dependency chain (deeper levels stay at this step). */
export const MAX_NAV_DEPTH = 3;

/**
 * A plan's tasks in sidebar order: by dependency layer (what can run first comes first), then
 * by position in the layer, each with its indent depth. Same layering as the DAG view.
 */
export function sidebarTaskOrder<T extends TaskView>(tasks: readonly T[]): { task: T; depth: number }[] {
  const byId = new Map(tasks.map((x) => [x.id, x]));
  return [...layoutTaskDag(tasks).nodes]
    .sort((a, b) => a.layer - b.layer || a.indexInLayer - b.indexInLayer)
    .flatMap((n) => {
      const task = byId.get(n.id);
      return task ? [{ task, depth: Math.min(n.layer, MAX_NAV_DEPTH) }] : [];
    });
}

/**
 * The text a file click puts in the composer: `@<folder>/<path>`. The coordinator maps the
 * folder name to its granted path with `list_folders`; the renderer never knows the real path.
 * A reference containing whitespace is wrapped in backticks so it stays one token.
 */
export function folderMentionText(folderName: string, relPath: string): string {
  const ref = `@${folderName}/${relPath}`;
  return /\s/.test(ref) ? `\`${ref}\`` : ref;
}

/** Append `mention` to a draft (space-separated, once), bounded to `maxLength`. */
export function appendMention(draft: string, mention: string, maxLength: number): string {
  if (draft.includes(mention)) return draft;
  const prefix = draft.length > 0 && !/\s$/.test(draft) ? ' ' : '';
  const next = `${draft}${prefix}${mention} `;
  return next.length > maxLength ? draft : next;
}
