// A task's worker chat, read from the worker's own pi session file.
//
// A local worker is started with `--session-dir <dataDir>/task-sessions/<taskId>` (main picks
// the directory; nothing a worker or herdr reports is trusted as a path). pi appends one JSON
// record per line; the `message` records are the same messages the coordinator transcript
// loads, so the worker chat reuses its parser and the renderer its chat items.
//
// The file is read as a capped tail (a long session keeps only its newest messages) and the
// result is cached on (file, size, mtime): the renderer polls while a task runs.

import type { ChatItem } from '../../shared/workbench';
import { createTranscript } from './piEvents';

/** Bytes of a session file read (its tail): older messages of a very long session drop off. */
export const TASK_SESSION_TAIL_BYTES = 4 * 1024 * 1024;
/** Chat items a task's worker chat shows (the newest). */
export const TASK_SESSION_ITEMS = 200;

/** pi's expanded `/skill:<name> args` (agent-session.js `_expandSkillCommand`). */
const SKILL_BLOCK_RE = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;
/** The word herdrCli.promptText puts before a prompt that would read as a pi command. */
const DEFUSED_PREFIX_RE = /^Message: (?=[!/-])/;

/** The newest `.jsonl` regular file of a listing (`kind` from a no-follow listing). */
export function newestSessionFile(entries: readonly { name: string; kind: string; mtimeMs: number }[]): string | null {
  let best: { name: string; mtimeMs: number } | null = null;
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.jsonl')) continue;
    // Ties (same mtime) break on the name: pi names files `<ISO time>_<id>.jsonl`.
    if (!best || e.mtimeMs > best.mtimeMs || (e.mtimeMs === best.mtimeMs && e.name > best.name)) best = e;
  }
  return best ? best.name : null;
}

/** How a user message reads in the chat: a skill command as typed, not pi's expansion. */
export function displayUserText(text: string): string {
  const skill = SKILL_BLOCK_RE.exec(text);
  if (skill) return skill[2] ? `/skill:${skill[1]} ${skill[2]}` : `/skill:${skill[1]}`;
  return text.replace(DEFUSED_PREFIX_RE, '');
}

/**
 * Chat items from a session file's text. `truncated`: the text is a tail, so its first line
 * may be cut mid-record and is dropped. Unparseable lines are skipped.
 */
export function parseTaskSession(text: string, truncated: boolean): ChatItem[] {
  const lines = text.split('\n');
  if (truncated) lines.shift();
  const messages: unknown[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record && typeof record === 'object' && (record as { type?: unknown }).type === 'message') {
      const message = (record as { message?: unknown }).message;
      if (message && typeof message === 'object') messages.push(message);
    }
  }
  const transcript = createTranscript();
  transcript.load(messages);
  return transcript
    .window(TASK_SESSION_ITEMS)
    .items.map((item) => (item.kind === 'user' ? { ...item, text: displayUserText(item.text) } : item));
}
