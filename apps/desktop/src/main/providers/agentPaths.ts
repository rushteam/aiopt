// Where each agent keeps its native config on disk.
//
// This is DELIBERATELY separate from main/paths.ts: that module is the userData-only
// map for AiOpt's own data, whereas these paths live under the user's HOME
// (`~/.claude`, `~/.codex`, …) — writing there is a privileged capability outside
// userData (see docs/dev-rules/credentials-and-local-storage.md and the plan's
// security review). Two guardrails keep it safe:
//
//   1. `AIOPT_AGENT_HOME` overrides the home dir, so dev/test runs point at a
//      sandbox and never touch the developer's real `~/.claude`.
//   2. `isAllowedAgentConfigPath` is a strict allowlist — only the exact files
//      declared below may be written; fsutil refuses anything else.

import os from 'node:os';
import path from 'node:path';
import { AGENT_SPECS, type AgentId, type AgentSpec } from '../../shared/aiProviders';

/**
 * The home directory agent configs live under. `AIOPT_AGENT_HOME` (dev/test
 * sandbox) wins over the real OS home so we never clobber a developer's own config.
 */
export function agentHome(): string {
  const override = process.env.AIOPT_AGENT_HOME;
  return override && override.trim() !== '' ? override : os.homedir();
}

/** Agent ids whose spec declares a binding (its config files exist). */
type BindableAgentId = {
  [K in keyof typeof AGENT_SPECS]: (typeof AGENT_SPECS)[K]['binding'] extends null ? never : K;
}[keyof typeof AGENT_SPECS];

/**
 * The write allowlist, DERIVED from {@link AGENT_SPECS}: each bindable agent's `files`
 * map (role → path relative to home), so adapters reference config by role
 * (`AGENT_FILES.dsh.settings`) rather than by array index. This map doubles as the write
 * allowlist — only the exact paths declared here may be written, and only for agents with
 * a binding. The mapped type below preserves each agent's LITERAL file paths, so those
 * per-role accesses keep their precise types.
 *
 * Note the non-uniform layouts (declared in the specs): pi keeps three files under
 * `.pi/agent`, OpenCode lives under `.config/opencode`.
 */
export const AGENT_FILES = Object.fromEntries(
  (Object.entries(AGENT_SPECS) as [AgentId, AgentSpec][])
    .filter(([, spec]) => spec.binding !== null)
    .map(([id, spec]) => [id, spec.binding!.files]),
) as { [K in BindableAgentId]: (typeof AGENT_SPECS)[K]['binding'] extends { files: infer F } ? F : never };

/** The directory whose existence signals an agent is installed — derived from {@link AGENT_SPECS}. */
const AGENT_INSTALL_DIRS: Partial<Record<AgentId, string>> = Object.fromEntries(
  (Object.entries(AGENT_SPECS) as [AgentId, AgentSpec][])
    .filter(([, spec]) => spec.binding !== null)
    .map(([id, spec]) => [id, spec.binding!.installDir]),
);

/** Resolve one relative config file (from AGENT_FILES) to an absolute path under home. */
export function resolveAgentFile(relativePath: string): string {
  return path.join(agentHome(), relativePath);
}

/**
 * Role → absolute path for one agent's managed config files, in spec order (empty for an
 * agent that declares none). The role-keyed primitive {@link agentConfigPaths} and
 * {@link resolveAgentConfigRole} are both built on: a caller names a file symbolically
 * rather than by array index, which is what lets the renderer refer to one without a path.
 */
export function agentConfigFiles(id: AgentId): { role: string; path: string }[] {
  const files = AGENT_FILES[id as keyof typeof AGENT_FILES] as
    | Readonly<Record<string, string>>
    | undefined;
  return Object.entries(files ?? {}).map(([role, rel]) => ({ role, path: resolveAgentFile(rel) }));
}

/** Absolute config paths for one agent under the current home (empty if none declared). */
export function agentConfigPaths(id: AgentId): string[] {
  return agentConfigFiles(id).map(({ path: abs }) => abs);
}

/** The directory an agent stores its config in (used for install detection). */
export function agentConfigDir(id: AgentId): string {
  return path.join(agentHome(), AGENT_INSTALL_DIRS[id] ?? `.${id}`);
}

/**
 * Resolve an (agentId, role) pair to an absolute config path, or null when the agent
 * declares no such role. `role` arrives from the renderer, so the lookup is an OWN-property
 * check: a plain `files[role]` would happily return `Object.prototype.toString` for
 * `role: 'toString'` and hand a non-path downstream.
 */
export function resolveAgentConfigRole(id: AgentId, role: string): string | null {
  const files = AGENT_FILES[id as keyof typeof AGENT_FILES] as
    | Readonly<Record<string, string>>
    | undefined;
  if (!files || !Object.hasOwn(files, role)) return null;
  const rel = files[role];
  return typeof rel === 'string' ? resolveAgentFile(rel) : null;
}

/** Every allowlisted config path across all declared agents, for the current home. */
function allAllowedConfigPaths(): string[] {
  const home = agentHome();
  return Object.values(AGENT_FILES)
    .flatMap((files) => Object.values(files))
    .map((rel) => path.join(home, rel));
}

/**
 * Whether the host filesystem treats two spellings of a path as the same file. Keyed on the
 * platform rather than probed, so the check stays a pure comparison with no disk access. Both
 * branches are here together per engineering-conventions.md §3.
 *
 * Not universally true of either platform — macOS can be formatted case-sensitive, and a Windows
 * volume can have per-directory case sensitivity enabled — but erring toward case-insensitive is
 * the fail-closed direction: it can only ever ACCEPT a differently-cased spelling of a path that
 * is already on the allowlist, never a path outside it.
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Whether `target` is one of the exact allowlisted agent config files. Compared as
 * resolved absolute paths so `..` traversal can never smuggle a path past the list.
 *
 * On Windows and macOS the comparison is case-insensitive, because the FILESYSTEM is: NTFS and
 * APFS both treat `C:\Users\Bob\.claude` and `c:\users\bob\.claude` as one file, while
 * `path.resolve` preserves whatever case it was handed and does not canonicalize a drive letter.
 * A case-sensitive compare there is not stricter, only wrong in a different direction — it would
 * refuse a legitimate path (fail-closed, surfacing as an unexplainable PERMISSION_DENIED) without
 * ever widening what may be written, since the set of allowed paths is unchanged.
 *
 * This deliberately does NOT try to canonicalize further. 8.3 short names (`C:\Users\JOHNSM~1`),
 * UNC and `\\?\` forms, symlinks and junctions all still compare unequal, and that is the safe
 * direction: refusing a path AiOpt would have been willing to write costs the user an error
 * message, whereas accepting an unexpected form could widen the boundary. Resolving those would
 * mean hitting the filesystem (`fs.realpathSync`) inside a security check, which introduces its
 * own TOCTOU and error-handling questions — out of scope here.
 *
 * Linux stays case-sensitive: ext4 and friends are, so two spellings really are two files.
 */
export function isAllowedAgentConfigPath(target: string): boolean {
  const resolved = normalizeForCompare(path.resolve(target));
  return allAllowedConfigPaths().some(
    (allowed) => normalizeForCompare(path.resolve(allowed)) === resolved,
  );
}

/** Case-fold on the platforms whose filesystem is case-insensitive; identity elsewhere. */
function normalizeForCompare(resolvedPath: string): string {
  return CASE_INSENSITIVE_FS ? resolvedPath.toLowerCase() : resolvedPath;
}

/** Convenience: Claude Code's settings file (`~/.claude/settings.json`). */
export function claudeSettingsPath(): string {
  return resolveAgentFile(AGENT_FILES.claude.settings);
}
