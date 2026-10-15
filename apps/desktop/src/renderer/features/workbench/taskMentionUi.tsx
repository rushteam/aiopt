import type { DragEvent, ReactNode } from 'react';
import { token, fontSize, radius } from '../../themes/tokens';
import {
  TASK_MENTION_DRAG_TYPE,
  TASK_MENTION_RE,
  parseTaskMentionDrag,
  taskMentionToken,
} from '../../../shared/taskMention';
import type { TaskView } from '../../../shared/workbench';
import { SESSION_MENTION_RE } from '../../../shared/sessionMention';

export function insertTaskMention(draft: string, taskId: string, maxLength: number): string {
  const token = taskMentionToken(taskId);
  if (draft.includes(token)) return draft;
  const prefix = draft.length > 0 && !draft.endsWith(' ') && !draft.endsWith('\n') ? ' ' : '';
  return (draft + prefix + token + ' ').slice(0, maxLength);
}

export function acceptTaskMentionDrag(e: DragEvent): void {
  if (e.dataTransfer.types.includes(TASK_MENTION_DRAG_TYPE)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
}

export function readTaskMentionDrop(e: DragEvent): { id: string; title: string } | null {
  return parseTaskMentionDrag(e.dataTransfer.getData(TASK_MENTION_DRAG_TYPE));
}

/** Chips for @task and @session tokens. A session chip shows the agent and a short id. */
export function renderTextWithTaskMentions(text: string, tasks: readonly TaskView[]): ReactNode {
  const byId = new Map(tasks.map((t) => [t.id, t.title]));
  const found: { index: number; length: number; key: string; label: string; title: string }[] = [];
  for (const match of text.matchAll(TASK_MENTION_RE)) {
    const id = match[1]!;
    found.push({ index: match.index ?? 0, length: match[0].length, key: `t-${id}`, label: `@${byId.get(id) ?? id}`, title: taskMentionToken(id) });
  }
  for (const match of text.matchAll(SESSION_MENTION_RE)) {
    found.push({
      index: match.index ?? 0,
      length: match[0].length,
      key: `s-${match[2]}`,
      label: `@${match[1]} ${match[2]!.slice(0, 8)}`,
      title: match[0],
    });
  }
  found.sort((a, b) => a.index - b.index);
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of found) {
    if (m.index < last) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span key={`${m.key}-${m.index}`} title={m.title} style={chipStyle}>
        {m.label}
      </span>,
    );
    last = m.index + m.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : text;
}

const chipStyle = {
  display: 'inline',
  padding: '0 4px',
  borderRadius: radius.sm,
  background: token('surfaceHover'),
  color: token('accent'),
  fontSize: fontSize.sm,
  fontWeight: 600,
} as const;
