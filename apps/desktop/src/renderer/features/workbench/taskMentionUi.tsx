import type { DragEvent, ReactNode } from 'react';
import { token, fontSize, radius } from '../../themes/tokens';
import {
  TASK_MENTION_DRAG_TYPE,
  TASK_MENTION_RE,
  parseTaskMentionDrag,
  taskMentionToken,
} from '../../../shared/taskMention';
import type { TaskView } from '../../../shared/workbench';

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

export function renderTextWithTaskMentions(text: string, tasks: readonly TaskView[]): ReactNode {
  const byId = new Map(tasks.map((t) => [t.id, t.title]));
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TASK_MENTION_RE)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const id = match[1]!;
    const title = byId.get(id) ?? id;
    parts.push(
      <span
        key={`${id}-${index}`}
        title={taskMentionToken(id)}
        style={{
          display: 'inline',
          padding: '0 4px',
          borderRadius: radius.sm,
          background: token('surfaceHover'),
          color: token('accent'),
          fontSize: fontSize.sm,
          fontWeight: 600,
        }}
      >
        @{title}
      </span>,
    );
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : text;
}
