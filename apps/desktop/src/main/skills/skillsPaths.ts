// Path resolution for Skills — turns SYMBOLIC coordinates from the renderer into contained
// absolute paths, using base directories the main process holds itself.
//
// SECURITY (see docs/dev-rules/electron-security-and-process-boundaries.md): the renderer never
// sends an absolute path. It names a skill by `(scope, agentId?, name)`, and this module joins
// the name onto a base the main process owns — the central library path (resolved from the
// enum preference, never from the renderer) and each agent's home-relative skills dir. Every
// resolution re-validates the name with `isValidSkillName` (the traversal guard) and then
// asserts the result is a DIRECT child of the base (its parent is exactly the base). A name that
// is not a single safe segment, or that somehow resolves outside its base, is refused here —
// before skillsFs ever touches the disk. This is the "controlled grant, never a raw path" rule.

import * as path from 'node:path';
import type { AgentId } from '../../shared/aiProviders';
import { AGENT_IDS } from '../../shared/aiProviders';
import { AGENT_SKILL_DIRS, isValidSkillName } from '../../shared/skills';
import { throwIpcError } from '../ipc/validate';

/**
 * Resolves skill paths from base directories the caller supplies. `centralDir` comes from the
 * library-location preference; `homeDir` is `app.getPath('home')`. Both are absolute.
 */
export interface SkillPaths {
  /** The central library base directory (absolute). */
  centralDir: string;
  /** Absolute global skills dir for an agent, or `null` when the agent has no well-known dir. */
  agentDir(agentId: AgentId): string | null;
  /** Contained absolute path to a named skill in the central library. Throws on a bad name. */
  centralSkillPath(name: string): string;
  /** Contained absolute path to a named skill in an agent's dir. Throws on a bad name / unknown agent. */
  agentSkillPath(agentId: AgentId, name: string): string;
}

/** Assert `child` is a direct child of `base` (defence in depth on top of `isValidSkillName`). */
function containedChild(base: string, name: string): string {
  const baseResolved = path.resolve(base);
  const child = path.resolve(baseResolved, name);
  if (path.dirname(child) !== baseResolved || path.basename(child) !== name) {
    throwIpcError('PERMISSION_DENIED', 'resolved skill path escapes its base directory');
  }
  return child;
}

export function createSkillPaths(opts: { centralDir: string; homeDir: string }): SkillPaths {
  const centralDir = path.resolve(opts.centralDir);
  const homeDir = path.resolve(opts.homeDir);

  const agentDir = (agentId: AgentId): string | null => {
    const rel = AGENT_SKILL_DIRS[agentId];
    return rel === null ? null : path.join(homeDir, rel);
  };

  return {
    centralDir,

    agentDir,

    centralSkillPath(name: string): string {
      if (!isValidSkillName(name)) {
        throwIpcError('INVALID_PARAMS', `invalid skill name: ${String(name)}`);
      }
      return containedChild(centralDir, name);
    },

    agentSkillPath(agentId: AgentId, name: string): string {
      if (!(AGENT_IDS as readonly string[]).includes(agentId)) {
        throwIpcError('INVALID_PARAMS', `unknown agent id: ${String(agentId)}`);
      }
      const dir = agentDir(agentId);
      if (dir === null) {
        throwIpcError('UNSUPPORTED_CAPABILITY', `agent ${agentId} has no known skills directory`);
      }
      if (!isValidSkillName(name)) {
        throwIpcError('INVALID_PARAMS', `invalid skill name: ${String(name)}`);
      }
      return containedChild(dir, name);
    },
  };
}
