// Session search — shared by the Sessions screen and the @session picker in the Workbench
// coordinator composer, so both find a session the same way (title, folder, branch, model, id).
// Pure; no DOM.

import { AGENT_SPECS } from '../../../shared/aiProviders';
import type { SessionSummary } from '../../../shared/agentSessions';

export const agentName = (id: string): string =>
  Object.hasOwn(AGENT_SPECS, id) ? AGENT_SPECS[id as keyof typeof AGENT_SPECS].name : id;

/** Show the last two path segments — enough to recognise a project. */
export function shortDir(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join('/')}`;
}

/**
 * Whether a session matches a query. Every whitespace-separated word must appear in one of the
 * searchable fields (or the agent's name), case-insensitively. An empty query matches all.
 */
export function sessionMatches(s: SessionSummary, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const fields = [s.title, s.cwd, s.gitBranch, s.model, s.sessionId, agentName(s.agentId)].map((f) => f.toLowerCase());
  return words.every((w) => fields.some((f) => f.includes(w)));
}

/** The first `limit` matching sessions, in the given (newest-first) order. */
export function searchSessions(sessions: readonly SessionSummary[], query: string, limit: number): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const s of sessions) {
    if (!sessionMatches(s, query)) continue;
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// @-mention trigger in a text box
// ---------------------------------------------------------------------------

export interface MentionQuery {
  /** Index of the `@` in the text. */
  start: number;
  /** What follows the `@` up to the caret (may be ''). */
  query: string;
}

const MENTION_QUERY_MAX = 60;

/**
 * The @-query being typed at `caret`, or null. The `@` must start the text or follow
 * whitespace, and the query runs to the caret without a line break. Spaces are allowed (a
 * title has them) but a query that already is a complete `@task:` / `@session:` token, or
 * one ending in a space after a space, is not a trigger.
 */
export function activeMentionQuery(text: string, caret: number): MentionQuery | null {
  if (caret < 1 || caret > text.length) return null;
  const from = Math.max(0, caret - MENTION_QUERY_MAX - 1);
  const before = text.slice(from, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const start = from + at;
  if (start > 0 && !/\s/.test(text[start - 1]!)) return null;
  const query = text.slice(start + 1, caret);
  if (/[\r\n]/.test(query) || /\s\s$/.test(query) || /^\s/.test(query)) return null;
  if (/^(task|session):/.test(query)) return null;
  return { start, query };
}

/** Replace the @-query with `token` and a trailing space; returns the new text and caret. */
export function applyMention(
  text: string,
  q: MentionQuery,
  caret: number,
  token: string,
  maxLength: number,
): { text: string; caret: number } {
  const head = text.slice(0, q.start) + token + ' ';
  const tail = text.slice(caret).replace(/^ /, '');
  if (head.length + tail.length > maxLength) return { text, caret };
  return { text: head + tail, caret: head.length };
}
