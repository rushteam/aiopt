// What the Workbench content area shows, and the pure helpers the sidebar and explorer use.

import { layoutTaskDag } from '../../../shared/taskDagLayout';
import { foldSearchText, searchExcerpt, searchQueryTerms, type TaskView } from '../../../shared/workbench';

/**
 * What the content area shows: the coordinator chat, the plan graph, the task timeline, one
 * task (all sidebar tabs), or a read-only preview of a file picked in the explorer.
 */
export type WorkbenchView =
  | { kind: 'chat' }
  | { kind: 'plan' }
  | { kind: 'timeline' }
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

/** Where a sidebar search hit matched, so the row can say why it is listed. */
export type TaskMatchField = 'title' | 'prompt' | 'thread' | 'branch';

export interface TaskSearchHit<T extends TaskView> {
  task: T;
  field: TaskMatchField;
  /** A short excerpt around the match; '' when the title itself matched. */
  snippet: string;
}

/** Folded (NFKC + lower case), whitespace-separated terms of a search query. */
export const searchTerms = searchQueryTerms;

/**
 * Tasks matching every term somewhere in their title, prompt, follow-ups or branch, most
 * recently updated first. The hit names the field that holds the first term (title preferred)
 * and an excerpt from it, so a row titled "Fix bug" can show the prompt line that matched.
 */
export function searchTasks<T extends TaskView>(tasks: readonly T[], query: string): TaskSearchHit<T>[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const hits: TaskSearchHit<T>[] = [];
  for (const task of tasks) {
    const fields: [TaskMatchField, string][] = [
      ['title', task.title],
      ['prompt', task.prompt],
      ['thread', task.thread.map((m) => m.text).join('\n')],
      ['branch', task.branch ?? ''],
    ];
    const lower = fields.map(([, text]) => foldSearchText(text));
    if (!terms.every((term) => lower.some((text) => text.includes(term)))) continue;
    const first = terms[0]!;
    const i = lower.findIndex((text) => text.includes(first));
    const [field, text] = fields[i]!;
    const snippet = field === 'title' ? '' : searchExcerpt(text, first);
    hits.push({ task, field, snippet });
  }
  return hits.sort((a, b) => b.task.updatedAt - a.task.updatedAt);
}

/** Saved conversations whose title holds every term. */
export function searchConversations<C extends { title: string }>(conversations: readonly C[], query: string): C[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  return conversations.filter((c) => {
    const title = foldSearchText(c.title);
    return terms.every((term) => title.includes(term));
  });
}
