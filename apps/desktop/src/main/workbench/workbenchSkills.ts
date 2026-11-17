// The Skills library as the workbench's task workers see it: which skills a task can run as
// `/skill:<name>`, and the pi flags that load them.
//
// The library is the central Skills directory the Skills screen manages (main resolves it from
// the `skillsLibrary` preference; the renderer never names a path). Only `SKILL.md` frontmatter is
// read here — name and description, for the `/` picker. Skills are loaded by the worker's pi,
// which already runs with full tools, so a skill adds instructions, not privileges.
//
// pi discovers `~/.agents/skills` on its own (even with PI_CODING_AGENT_DIR pointed at the
// workbench's agent dir). When the library is that directory, no `--skill` flags are passed, so
// each skill is loaded once. With task skills off, workers get `--no-skills`: no discovered skill
// at all, the library's or a project's.

import { isValidSkillName, type SkillMeta } from '../../shared/skills';
import type { WorkbenchSkillView } from '../../shared/workbench';

/** The slice of the Skills filesystem core this reads (no writes). */
export interface SkillLibraryFs {
  listSkillNames(baseDir: string): string[];
  readMeta(skillDir: string): SkillMeta | null;
}

export interface WorkbenchSkill extends WorkbenchSkillView {
  /** Absolute skill directory (main only; never sent to the renderer). */
  dir: string;
}

export interface SkillLibraryScan {
  skills: WorkbenchSkill[];
  /** pi finds this library by itself (it is `~/.agents/skills`), so no `--skill` flags. */
  autoDiscovered: boolean;
}

export const EMPTY_SKILL_SCAN: SkillLibraryScan = { skills: [], autoDiscovered: false };

/** More than this many skills are not offered (or loaded) — a bound, not an expected size. */
export const WORKBENCH_SKILLS_MAX = 200;
/** Description shown in the picker, in characters. */
export const SKILL_DESCRIPTION_MAX = 300;

/** pi's (and the Agent Skills spec's) command name: lowercase words joined by single hyphens. */
const SKILL_COMMAND_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSkillCommandName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 64 && SKILL_COMMAND_RE.test(name);
}

function cleanDescription(text: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > SKILL_DESCRIPTION_MAX ? `${flat.slice(0, SKILL_DESCRIPTION_MAX - 1)}…` : flat;
}

/**
 * The library's loadable skills, by command name. A skill pi would not load (no description) or
 * whose name is not a valid command is left out; the first of two with one name wins, as in pi.
 */
export function scanSkillLibrary(
  fs: SkillLibraryFs,
  libraryDir: string,
  join: (dir: string, name: string) => string,
  autoDiscovered: boolean,
): SkillLibraryScan {
  const skills: WorkbenchSkill[] = [];
  const seen = new Set<string>();
  for (const entry of fs.listSkillNames(libraryDir)) {
    if (skills.length >= WORKBENCH_SKILLS_MAX) break;
    if (!isValidSkillName(entry)) continue;
    const dir = join(libraryDir, entry);
    const meta = fs.readMeta(dir);
    if (!meta || !isSkillCommandName(meta.name) || seen.has(meta.name)) continue;
    const description = cleanDescription(meta.description ?? '');
    if (description === '') continue;
    seen.add(meta.name);
    skills.push({ name: meta.name, description, dir });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, autoDiscovered };
}

/** pi flags for a local worker. */
export function workerSkillArgs(scan: SkillLibraryScan, enabled: boolean): string[] {
  if (!enabled) return ['--no-skills'];
  if (scan.autoDiscovered) return [];
  return scan.skills.flatMap((s) => ['--skill', s.dir]);
}

/** What the renderer's `/` picker offers: names and descriptions, no paths. */
export function skillViews(scan: SkillLibraryScan): WorkbenchSkillView[] {
  return scan.skills.map(({ name, description }) => ({ name, description }));
}

/** Compares two scans by what a worker would load. */
export function skillScanSignature(scan: SkillLibraryScan): string {
  return JSON.stringify([scan.autoDiscovered, scan.skills.map((s) => [s.name, s.description, s.dir])]);
}

/**
 * pi expands `/skill:<name>` only when a space follows the name; a prompt that puts the request
 * on the next line instead would reach the worker unexpanded. Joins that first break with a space.
 */
export function skillCommandLine(prompt: string): string {
  const m = /^\/skill:([a-z0-9-]{1,64})[ \t]*\r?\n[ \t\r\n]*/.exec(prompt);
  if (!m) return prompt;
  return `/skill:${m[1]} ${prompt.slice(m[0].length)}`;
}
