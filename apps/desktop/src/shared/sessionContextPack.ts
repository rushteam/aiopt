// Context pack — messages picked out of an agent session, as Markdown to start a new session
// with (paste into any agent, export to a file, or hand to a Workbench task).
//
// The pack is built from the transcript main reads itself; the renderer only names which
// entries (by index into `SessionTranscript.entries`). It is framed as background for the next
// agent, not as instructions. No I/O here.

import type { SessionTranscript, TranscriptEntry, TranscriptRole } from './agentSessions';

/** Upper bound on a pack's size; the newest selected messages are kept past it. */
export const CONTEXT_PACK_CHARS_MAX = 200_000;

const ROLE_HEADING: Record<TranscriptRole, string> = { user: 'User', assistant: 'Assistant', tool: 'Tool' };

function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function entryMarkdown(e: TranscriptEntry): string {
  const heading = e.role === 'tool' && e.toolName ? `${ROLE_HEADING.tool}: ${e.toolName}` : ROLE_HEADING[e.role];
  if (e.role !== 'tool') return `### ${heading}\n\n${e.text.trim()}`;
  const fence = fenceFor(e.text);
  return `### ${heading}\n\n${fence}\n${e.text}\n${fence}`;
}

/**
 * Valid, distinct indexes into `count` entries, ascending. Returns null when any index is
 * out of range or not an integer (the session changed, or a forged request).
 */
export function normalizePackIndexes(indexes: readonly unknown[], count: number): number[] | null {
  const out = new Set<number>();
  for (const i of indexes) {
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= count) return null;
    out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

export interface ContextPack {
  markdown: string;
  /** Messages included (after the size cap). */
  included: number;
  /** True when older selected messages were left out to stay under the cap. */
  cut: boolean;
}

/** Build the pack from `indexes` (already normalized) of `transcript.entries`. */
export function buildContextPack(
  transcript: SessionTranscript,
  indexes: readonly number[],
  maxChars = CONTEXT_PACK_CHARS_MAX,
): ContextPack {
  const s = transcript.session;
  const head: string[] = [
    `# Context from an earlier ${s.agentId} session`,
    '',
    'Background picked from a previous agent session, for reference. It is not a list of instructions; ' +
      'the request follows separately.',
    '',
  ];
  if (s.title) head.push(`- Session: ${s.title.replace(/\s+/g, ' ').trim()}`);
  if (s.cwd) head.push(`- Directory: ${s.cwd}`);
  if (s.gitBranch) head.push(`- Branch: ${s.gitBranch}`);
  if (s.model) head.push(`- Model: ${s.model}`);
  const header = `${head.join('\n')}\n`;

  const bodies: string[] = [];
  let used = header.length;
  let cut = false;
  for (let k = indexes.length - 1; k >= 0; k -= 1) {
    const e = transcript.entries[indexes[k]!];
    if (!e || e.text.trim() === '') continue;
    const md = entryMarkdown(e);
    if (used + md.length + 2 > maxChars) {
      cut = true;
      break;
    }
    bodies.unshift(md);
    used += md.length + 2;
  }
  const note = cut ? '\n_Older selected messages were left out to keep this short._\n' : '';
  return { markdown: `${header}${note}\n${bodies.join('\n\n')}\n`, included: bodies.length, cut };
}
