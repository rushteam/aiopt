// Skills management — pure types + constants + pure validation, shared by main and renderer.
//
// A "skill" is a DIRECTORY containing a `SKILL.md` file whose YAML frontmatter carries a
// `name` + `description` (the shape used by skills-cli and the agents that consume skills).
// AiOpt acts as the CENTRAL library: it discovers skills in each agent's global skills dir,
// pulls them into the central library, pushes them back out, and diffs the two.
//
// SECURITY (see docs/dev-rules/electron-security-and-process-boundaries.md): the renderer
// never handles absolute paths. It refers to a skill by SYMBOLIC coordinates — a scope, an
// optional agentId, and a validated single-segment `name` — and main resolves the real path
// from base directories it holds itself. `isValidSkillName` is the traversal guard that both
// sides can call; main re-validates before any filesystem side effect.
//
// No I/O, no Electron here.

import type { AgentId } from './aiProviders';

/** Where a skill lives. v1 covers the central library and each agent's GLOBAL (home) skills dir. */
export type SkillScope = 'central' | 'agent';

/**
 * Each agent's global skills directory, relative to the user's home directory. Taken from
 * skills-cli's default agent map. `null` means AiOpt has no well-known skills dir for that
 * agent (e.g. grok) — its column is shown as "unknown" and it does not participate in sync.
 * Main joins the non-null value onto `app.getPath('home')`; the renderer only reads it for display.
 */
export const AGENT_SKILL_DIRS: Record<AgentId, string | null> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  gemini: '.gemini/skills',
  grok: null,
  opencode: '.config/opencode/skills',
  pi: '.pi/agent/skills',
};

/** Parsed `SKILL.md` frontmatter. `null` meta means the dir had no readable name (still a skill dir). */
export interface SkillMeta {
  name: string;
  description?: string;
}

/** One discovered skill at one location. Counts/bytes drive the size cap and are shown in the UI. */
export interface SkillEntry {
  /** Directory name (the skill's identity across locations). Always a valid skill name. */
  name: string;
  meta: SkillMeta | null;
  fileCount: number;
  totalBytes: number;
  /**
   * Newest file mtime under the skill dir, in ms since the epoch; 0 when unknown or empty.
   * When two copies differ, the side with the larger value is the more recently edited one —
   * a hint (mtime is not a version number), used to point at the likely sync direction.
   */
  modifiedAt: number;
}

/**
 * Which copy of a differing skill was edited more recently, or null when it can't be told
 * (a copy missing, either mtime unknown, or an exact tie). Pure — the UI turns this into the
 * suggested sync direction (agent newer → pull ←, central newer → push →).
 */
export function newerSkillSide(
  central: Pick<SkillEntry, 'modifiedAt'> | null,
  agent: Pick<SkillEntry, 'modifiedAt'> | null,
): 'central' | 'agent' | null {
  if (!central || !agent) return null;
  if (!central.modifiedAt || !agent.modifiedAt) return null;
  if (central.modifiedAt === agent.modifiedAt) return null;
  return central.modifiedAt > agent.modifiedAt ? 'central' : 'agent';
}

/** How a given agent's copy relates to the central library's copy. */
export type SkillSyncState = 'same' | 'central-only' | 'agent-only' | 'differs';

/** One agent's cell in a matrix row: its copy (or null) and how it compares to central. */
export interface SkillCell {
  entry: SkillEntry | null;
  state: SkillSyncState;
}

/** One row of the sync matrix: a skill name, its central copy, and a cell per available agent. */
export interface SkillMatrixRow {
  name: string;
  central: SkillEntry | null;
  agents: Partial<Record<AgentId, SkillCell>>;
}

/** An agent column header in the matrix. `available` is false when the agent has no known dir. */
export interface SkillAgentColumn {
  id: AgentId;
  name: string;
  /** Resolved global skills dir (shortened for display), or null when unknown. */
  dir: string | null;
  available: boolean;
}

/** Where the central library points. `'app'` = userData/skills; `'home'` = ~/.aiopt/skills. */
export type SkillsLibraryLocation = 'app' | 'home';

/** The scanned view of the world handed to the renderer. */
export interface SkillsSnapshot {
  libraryLocation: SkillsLibraryLocation;
  /** Central library path, shortened for display (e.g. `~/.aiopt/skills`). */
  centralPath: string;
  agents: SkillAgentColumn[];
  rows: SkillMatrixRow[];
  scannedAt: number;
}

/** One changed file within a skill, for the diff panel. Metadata only — no file contents. */
export interface SkillFileDiff {
  relPath: string;
  status: 'added' | 'modified' | 'deleted';
  binary: boolean;
}

/**
 * The diff between an agent's copy and the central copy of one skill. `added`/`deleted` are
 * relative to CENTRAL as the source: `added` = present in central but not in the agent.
 */
export interface SkillDiffResult {
  name: string;
  agentId: AgentId;
  files: SkillFileDiff[];
}

/**
 * A reveal target for "open in file manager": the central library, an agent's skills dir, or a
 * specific skill within either. Symbolic coordinates only — main resolves the real path.
 */
export interface SkillRevealRef {
  scope: SkillScope;
  agentId?: AgentId;
  name?: string;
}

/**
 * One file's content for the diff preview. `text` is null when the file is binary (a NUL byte was
 * seen) or absent on that side; `truncated` marks text clipped at the preview cap. Content only —
 * skill files are read as inert text and never executed.
 */
export interface SkillFileContent {
  text: string | null;
  binary: boolean;
  truncated: boolean;
}

/** Hard caps on a single skill copy, to refuse absurd or hostile sources (e.g. a symlinked home). */
export const SKILL_MAX_FILES = 2000;
export const SKILL_MAX_BYTES = 25 * 1024 * 1024;

/** Max bytes returned for a single-file diff preview; larger text is truncated with a marker. */
export const SKILL_PREVIEW_MAX_BYTES = 256 * 1024;

/** True if `s` contains any C0 control char (0x00–0x1F) or DEL (0x7F). Uses codes, no char literals. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * True when `name` is a safe single path segment usable as a skill directory name. Rejects
 * empty, over-long, separators, traversal (`..`), the `.`/`..` specials, hidden (dot-leading)
 * names, and control characters. This is the traversal guard — main calls it before resolving
 * any skill path, so a hostile renderer cannot escape a base directory via the name.
 */
export function isValidSkillName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 128) return false;
  if (name === '.' || name === '..') return false;
  if (name.startsWith('.')) return false;
  if (name.includes('..')) return false;
  if (/[/\\]/.test(name)) return false;
  if (hasControlChar(name)) return false;
  return true;
}

/**
 * Classify an agent's copy against the central copy. `differs` is only consulted when both
 * exist (computed by the store via a directory comparison). Pure.
 */
export function computeSyncState(hasCentral: boolean, hasAgent: boolean, differs: boolean): SkillSyncState {
  if (hasCentral && hasAgent) return differs ? 'differs' : 'same';
  if (hasCentral) return 'central-only';
  return 'agent-only';
}
