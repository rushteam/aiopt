// What a chat composer offers after a leading `/`: the app's own commands (run here, never sent)
// and the Skills library's skills (inserted as `/skill:<name> `; the task worker's pi expands
// them). Pure; no DOM.

import type { WorkbenchSkillView } from '../../../shared/workbench';
import type { MentionOption } from './mentionSuggest';
import type { MentionQuery } from '../sessions/sessionSearch';

/** A command the composer runs itself (e.g. `/new`). */
export interface LocalSlashCommand {
  name: string;
  description: string;
  run: () => void;
}

export const SLASH_OPTIONS_MAX = 50;

/**
 * The `/` query under the caret: only at the very start of the draft, and only while the caret
 * is still in the command word (no space typed yet).
 */
export function activeSlashQuery(text: string, caret: number): MentionQuery | null {
  if (caret < 1 || caret > text.length || text[0] !== '/') return null;
  const query = text.slice(1, caret);
  if (!/^[a-z0-9:-]{0,80}$/i.test(query)) return null;
  return { start: 0, query };
}

function score(name: string, q: string): number {
  if (q === '') return 1;
  if (name.startsWith(q)) return 3;
  if (name.split('-').some((w) => w.startsWith(q))) return 2;
  return name.includes(q) ? 1 : 0;
}

/** Commands first, then skills; each by match quality, then name. `skill:` in the query is optional. */
export function slashOptions(
  query: string,
  commands: readonly LocalSlashCommand[],
  skills: readonly WorkbenchSkillView[],
): MentionOption[] {
  const raw = query.toLowerCase();
  const skillOnly = raw.startsWith('skill:');
  const q = skillOnly ? raw.slice('skill:'.length) : raw;
  const ranked = <T extends { name: string }>(items: readonly T[]): T[] =>
    items
      .map((item) => ({ item, s: score(item.name.toLowerCase(), q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.item.name.localeCompare(b.item.name))
      .map((x) => x.item);
  const out: MentionOption[] = [];
  if (!skillOnly) {
    for (const c of ranked(commands)) {
      out.push({
        key: `command:${c.name}`,
        kind: 'command',
        token: `/${c.name}`,
        label: `/${c.name}`,
        detail: c.description,
        run: c.run,
      });
    }
  }
  for (const s of ranked(skills)) {
    if (out.length >= SLASH_OPTIONS_MAX) break;
    out.push({
      key: `skill:${s.name}`,
      kind: 'skill',
      token: `/skill:${s.name}`,
      label: s.name,
      detail: s.description,
    });
  }
  return out;
}
