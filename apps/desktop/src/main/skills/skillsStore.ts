// Skills store — the main-process brain for the central library ⇄ agents sync matrix.
//
// Unlike the provider/usage stores, this one has NO persistence file of its own: the skill
// DIRECTORIES on disk are the source of truth, and `snapshot()` is a live scan. It holds only
// the resolved base directories (central library path from the enum preference; the user's home
// for agent dirs) and delegates every filesystem touch to the injected `SkillsFs`, so it unit-
// tests against a temp dir with no Electron.
//
// SECURITY: callers pass SYMBOLIC coordinates — an `agentId` and a `name` — never a path. The
// store resolves them through `skillsPaths` (name validation + base containment) before handing
// an absolute path to `skillsFs` (which refuses symlinks and enforces size caps). Import is the
// one path that originates outside: its source comes from a main-side folder picker (never the
// renderer), and it is still copied through the same symlink/size-guarded `replaceDir`.

import type { AgentId } from '../../shared/aiProviders';
// Skills enumerates ALL known agents (AGENT_IDS), not the binding registry (AGENTS):
// a skills-only agent like `cursor` participates in sync but is absent from AGENTS.
import { AGENT_IDS, AGENT_NAMES } from '../../shared/aiProviders';
import {
  computeSyncState,
  SKILL_PREVIEW_MAX_BYTES,
  type SkillAgentColumn,
  type SkillDiffResult,
  type SkillEntry,
  type SkillFileContent,
  type SkillMatrixRow,
  type SkillRevealRef,
  type SkillScope,
  type SkillsLibraryLocation,
  type SkillsSnapshot,
} from '../../shared/skills';
import { throwIpcError } from '../ipc/validate';
import { createSkillPaths, type SkillPaths } from './skillsPaths';
import { SKILL_MARKER, type SkillsFs } from './skillsFs';
import path from 'node:path';

export interface SkillsStoreDeps {
  fs: SkillsFs;
  /** The user's home directory (absolute); agent dirs are resolved relative to it. */
  homeDir: string;
  /** Current library-location preference (read fresh so a change is reflected on next scan). */
  getLibraryLocation: () => SkillsLibraryLocation;
  /** Resolve a library location to its absolute central directory (main/paths.skillsLibraryPath). */
  centralDirFor: (location: SkillsLibraryLocation) => string;
  /** Shorten an absolute path for display (e.g. `~/…`). Optional; identity by default. */
  displayPath?: (abs: string) => string;
  /** Clock for `scannedAt`. Injectable for deterministic tests. */
  now?: () => number;
}

export interface SkillsStore {
  /** Live scan of the central library + every available agent dir into the sync matrix. */
  snapshot(): SkillsSnapshot;
  /** Copy an agent's copy of a skill INTO the central library (agent → central). */
  pull(agentId: AgentId, name: string): void;
  /** Copy the central library's copy of a skill OUT to an agent (central → agent). */
  push(name: string, agentId: AgentId): void;
  /** Import a skill directory (chosen via a main-side picker) into the central library. */
  importFromDir(srcAbsPath: string): string;
  /** Delete a skill from the central library (destructive; the IPC layer confirms first). */
  deleteCentral(name: string): void;
  /** Delete an agent's own copy of a skill (destructive; the IPC layer confirms first). */
  deleteAgent(agentId: AgentId, name: string): void;
  /** Per-file diff of an agent's copy against the central copy of one skill. */
  diff(agentId: AgentId, name: string): SkillDiffResult;
  /** Read one differing file's content (from `side`) for the diff preview. Text/size-capped. */
  fileContent(agentId: AgentId, name: string, side: SkillScope, relPath: string): SkillFileContent;
  /**
   * Merge a differing skill back into the central library: take central's current content, then
   * for each `relPath` in `agentPicks` use the agent's copy instead. The agent copy is untouched.
   */
  merge(agentId: AgentId, name: string, agentPicks: string[]): void;
  /** Resolve a reveal target to an absolute, contained directory path (for `shell.openPath`). */
  resolveRevealDir(ref: SkillRevealRef): string;
  onChange(listener: () => void): () => void;
}

export function createSkillsStore(deps: SkillsStoreDeps): SkillsStore {
  const { fs } = deps;
  const displayPath = deps.displayPath ?? ((abs: string) => abs);
  const nowFn = deps.now ?? (() => Date.now());

  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const l of listeners) l();
  };

  /** Build a `SkillPaths` for the CURRENT library location (re-read every call). */
  const currentPaths = (): { paths: SkillPaths; location: SkillsLibraryLocation; centralDir: string } => {
    const location = deps.getLibraryLocation();
    const centralDir = deps.centralDirFor(location);
    return { paths: createSkillPaths({ centralDir, homeDir: deps.homeDir }), location, centralDir };
  };

  /** A display entry for one skill directory. Never throws — measurement failure yields zeros. */
  const entryFor = (name: string, skillDir: string): SkillEntry => {
    const meta = fs.readMeta(skillDir);
    let fileCount = 0;
    let totalBytes = 0;
    let modifiedAt = 0;
    try {
      const m = fs.measure(skillDir);
      fileCount = m.fileCount;
      totalBytes = m.totalBytes;
      modifiedAt = m.modifiedAt;
    } catch {
      // Oversized / symlinked / unreadable: still list it, with unknown size.
    }
    return { name, meta, fileCount, totalBytes, modifiedAt };
  };

  return {
    snapshot(): SkillsSnapshot {
      const { paths, location, centralDir } = currentPaths();

      const centralNames = new Set(fs.listSkillNames(centralDir));

      // Columns + per-agent name sets, in registry order.
      const columns: SkillAgentColumn[] = [];
      const agentNames = new Map<AgentId, Set<string>>();
      for (const id of AGENT_IDS) {
        const dir = paths.agentDir(id);
        const available = dir !== null;
        columns.push({
          id,
          name: AGENT_NAMES[id],
          dir: dir === null ? null : displayPath(dir),
          available,
        });
        agentNames.set(id, new Set(available ? fs.listSkillNames(dir) : []));
      }

      // Union of every skill name across central + agents → one row each.
      const allNames = new Set<string>(centralNames);
      for (const names of agentNames.values()) for (const n of names) allNames.add(n);

      const rows: SkillMatrixRow[] = [];
      for (const name of [...allNames].sort()) {
        const hasCentral = centralNames.has(name);
        const central = hasCentral ? entryFor(name, paths.centralSkillPath(name)) : null;
        const row: SkillMatrixRow = { name, central, agents: {} };
        for (const id of AGENT_IDS) {
          if (paths.agentDir(id) === null) continue; // unavailable agent — no cell
          const hasAgent = agentNames.get(id)?.has(name) ?? false;
          if (!hasCentral && !hasAgent) continue; // no chip for an agent unrelated to this row
          const agentSkillDir = paths.agentSkillPath(id, name);
          const entry = hasAgent ? entryFor(name, agentSkillDir) : null;
          const differs =
            hasCentral && hasAgent ? fs.differs(paths.centralSkillPath(name), agentSkillDir) : false;
          row.agents[id] = { entry, state: computeSyncState(hasCentral, hasAgent, differs) };
        }
        rows.push(row);
      }

      return {
        libraryLocation: location,
        centralPath: displayPath(centralDir),
        agents: columns,
        rows,
        scannedAt: nowFn(),
      };
    },

    pull(agentId, name) {
      const { paths } = currentPaths();
      const src = paths.agentSkillPath(agentId, name);
      if (!fs.isSkillDir(src)) throwIpcError('NOT_FOUND', `agent skill not found: ${name}`);
      fs.replaceDir(src, paths.centralSkillPath(name));
      notify();
    },

    push(name, agentId) {
      const { paths } = currentPaths();
      const src = paths.centralSkillPath(name);
      if (!fs.isSkillDir(src)) throwIpcError('NOT_FOUND', `central skill not found: ${name}`);
      fs.replaceDir(src, paths.agentSkillPath(agentId, name));
      notify();
    },

    importFromDir(srcAbsPath) {
      // The source is a folder the user picked in a main-side dialog; treat it as one skill.
      if (typeof srcAbsPath !== 'string' || !path.isAbsolute(srcAbsPath)) {
        throwIpcError('INVALID_PARAMS', 'import source must be an absolute path');
      }
      if (!fs.isSkillDir(srcAbsPath)) {
        throwIpcError('NOT_FOUND', 'import source is not a directory');
      }
      // Require a SKILL.md so an arbitrary folder (e.g. ~/Documents) can't be slurped in.
      if (!fs.hasMarker(srcAbsPath)) {
        throwIpcError('INVALID_PARAMS', `not a skill: the folder has no ${SKILL_MARKER}`);
      }
      const { paths } = currentPaths();
      const name = path.basename(srcAbsPath);
      const dst = paths.centralSkillPath(name); // throws INVALID_PARAMS on a bad name
      fs.replaceDir(srcAbsPath, dst);
      notify();
      return name;
    },

    deleteCentral(name) {
      const { paths } = currentPaths();
      const dir = paths.centralSkillPath(name);
      if (!fs.isSkillDir(dir)) throwIpcError('NOT_FOUND', `central skill not found: ${name}`);
      fs.removeDir(dir);
      notify();
    },

    deleteAgent(agentId, name) {
      const { paths } = currentPaths();
      // agentSkillPath re-validates the name and enforces base containment; a bad name or an
      // agent with no known skills dir is refused before any path is touched.
      const dir = paths.agentSkillPath(agentId, name);
      if (!fs.isSkillDir(dir)) throwIpcError('NOT_FOUND', `agent skill not found: ${name}`);
      fs.removeDir(dir);
      notify();
    },

    diff(agentId, name) {
      const { paths } = currentPaths();
      const files = fs.compare(paths.centralSkillPath(name), paths.agentSkillPath(agentId, name));
      return { name, agentId, files };
    },

    fileContent(agentId, name, side, relPath) {
      const { paths } = currentPaths();
      const centralDir = paths.centralSkillPath(name);
      const agentDir = paths.agentSkillPath(agentId, name);
      // Only accept a relPath that main's own diff actually reports — the "controlled grant":
      // the renderer never gets to name an arbitrary path, only pick from what we computed.
      const known = new Set(fs.compare(centralDir, agentDir).map((f) => f.relPath));
      if (!known.has(relPath)) {
        throwIpcError('INVALID_PARAMS', `not a differing file: ${String(relPath)}`);
      }
      const dir = side === 'central' ? centralDir : agentDir;
      return fs.readTextFile(dir, relPath, SKILL_PREVIEW_MAX_BYTES);
    },

    merge(agentId, name, agentPicks) {
      const { paths } = currentPaths();
      const centralDir = paths.centralSkillPath(name);
      const agentDir = paths.agentSkillPath(agentId, name);
      if (!fs.isSkillDir(centralDir)) throwIpcError('NOT_FOUND', `central skill not found: ${name}`);
      if (!fs.isSkillDir(agentDir)) throwIpcError('NOT_FOUND', `agent skill not found: ${name}`);
      // Keep only picks that name a file main's diff reports — silently drop unknown/stale entries.
      const known = new Set(fs.compare(centralDir, agentDir).map((f) => f.relPath));
      const picks = agentPicks.filter((rel) => known.has(rel));
      fs.mergeInto(centralDir, agentDir, picks);
      notify();
    },

    resolveRevealDir(ref) {
      const { paths, centralDir } = currentPaths();
      if (ref.scope === 'central') {
        return ref.name ? paths.centralSkillPath(ref.name) : centralDir;
      }
      if (!ref.agentId) throwIpcError('INVALID_PARAMS', 'agent reveal requires an agentId');
      const dir = paths.agentDir(ref.agentId);
      if (dir === null) throwIpcError('UNSUPPORTED_CAPABILITY', 'agent has no skills directory');
      return ref.name ? paths.agentSkillPath(ref.agentId, ref.name) : dir;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
