// A narrow client over the `herdr` CLI.
//
// herdr is driven entirely through its CLI (each command talks to the session's socket and
// prints one JSON document). This module is the ONLY place that builds a herdr argv, and it
// does so from a closed set of subcommands with every argument typed: ids and names are
// validated against herdr's own shapes, paths come from main, and free text is sanitized. The
// session is always AiOpt's own (`--session aiopt`), never the user's `default`.
//
// Output quirks this client absorbs (herdr 0.8):
//   - success prints `{"id":…,"result":{…}}`; failure prints `{"error":{"code","message"}}` and
//     exits 1; a usage error prints plain text and exits 2;
//   - JSON is the default output — several subcommands reject `--json`, so it is never passed;
//   - `agent start` right after a pane is created can fail with `agent_pane_busy` while the
//     shell is still starting, so it is retried briefly.
//
// The exec is injected (execFile, no shell), so the client unit-tests without herdr installed.

import { isValidAgentName, isValidWorkbenchBranch, sanitizeWorkbenchText } from '../../shared/workbench';
import { toHerdrAgentStatus, type HerdrAgentStatus } from './taskModel';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a binary with an argv (no shell). Must resolve, not reject, on a non-zero exit. */
export type HerdrExec = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

/** A herdr command failure, carrying herdr's own error code (or `usage` / `exec` / `parse`). */
export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HerdrError';
  }
}

export interface HerdrPaneRef {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface HerdrWorktreeRef extends HerdrPaneRef {
  /** Absolute checkout path herdr chose (`~/.herdr/worktrees/<repo>/<branch>`). */
  path: string;
  /** herdr's repo key, for finding the repo's own workspace on teardown. */
  repoKey: string | null;
}

export interface HerdrWorkspaceRow {
  workspaceId: string;
  /** Present when the workspace is a git checkout herdr knows about. */
  repoKey: string | null;
  isLinkedWorktree: boolean;
}

export interface HerdrAgentRow {
  name: string;
  status: HerdrAgentStatus;
  workspaceId: string | null;
}

export interface HerdrClient {
  /** Whether the session's server is running. Never throws. */
  isRunning(): Promise<boolean>;
  stopServer(): Promise<void>;
  installPiIntegration(): Promise<void>;
  workspaceCreate(cwd: string, label: string): Promise<HerdrPaneRef>;
  worktreeCreate(repo: string, branch: string): Promise<HerdrWorktreeRef>;
  workspaceList(): Promise<HerdrWorkspaceRow[]>;
  workspaceClose(workspaceId: string): Promise<void>;
  /** Remove a herdr-managed checkout (never forced: a dirty checkout is kept and this throws). */
  worktreeRemove(workspaceId: string): Promise<void>;
  agentStart(name: string, paneId: string, piArgs: readonly string[]): Promise<void>;
  agentPrompt(name: string, text: string): Promise<void>;
  agentList(): Promise<HerdrAgentRow[]>;
  agentRead(name: string, lines: number): Promise<string>;
}

export interface HerdrClientOptions {
  binary: string;
  session: string;
  exec: HerdrExec;
  /** Waits between `agent_pane_busy` retries (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** `agent start` waits for pi's TUI to come up; herdr's own default readiness wait is 30s. */
const AGENT_START_TIMEOUT_MS = 45_000;
const PANE_BUSY_RETRIES = 6;
const PANE_BUSY_DELAY_MS = 750;
/** herdr's ids: `w3`, `w3:t1`, `w3:p2`. */
const WORKSPACE_ID_RE = /^w[0-9]{1,9}$/;
const PANE_ID_RE = /^w[0-9]{1,9}:p[0-9]{1,9}$/;
const MAX_PROMPT = 16_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Turn one herdr invocation's output into its `result` object, or throw a HerdrError. The JSON
 * error document may land on stdout or stderr, so both are tried.
 */
export function parseHerdrOutput(out: ExecResult): Record<string, unknown> {
  for (const stream of [out.stdout, out.stderr]) {
    const text = stream.trim();
    if (!text.startsWith('{')) continue;
    let doc: Record<string, unknown> | null;
    try {
      doc = asRecord(JSON.parse(text));
    } catch {
      continue;
    }
    const error = asRecord(doc?.error);
    if (error) {
      throw new HerdrError(str(error.code) ?? 'unknown', str(error.message) ?? 'herdr error');
    }
    const result = asRecord(doc?.result);
    if (result && out.code === 0) return result;
  }
  if (out.code === 2) throw new HerdrError('usage', firstLine(out.stderr || out.stdout));
  if (out.code === 0) throw new HerdrError('parse', 'unreadable herdr output');
  throw new HerdrError('exec', firstLine(out.stderr || out.stdout) || `exit ${String(out.code)}`);
}

function firstLine(text: string): string {
  return (text.trim().split('\n')[0] ?? '').slice(0, 200);
}

/**
 * Text for `agent prompt`. herdr types it into pi's editor, where a leading `!` runs a shell
 * command and a leading `/` a slash command — and a leading `-` would be read by herdr's own
 * option parser. A task prompt must only ever be a message, so any of those is prefixed with a
 * word (a leading space is NOT enough: pi trims it).
 */
export function promptText(text: string): string {
  const clean = sanitizeWorkbenchText(text).slice(0, MAX_PROMPT);
  return /^[!/-]/.test(clean) ? `Message: ${clean}` : clean;
}

function paneRef(result: Record<string, unknown>): HerdrPaneRef {
  const pane = asRecord(result.root_pane);
  const workspaceId = str(asRecord(result.workspace)?.workspace_id) ?? str(pane?.workspace_id);
  const paneId = str(pane?.pane_id);
  const tabId = str(pane?.tab_id) ?? str(asRecord(result.tab)?.tab_id);
  if (!workspaceId || !paneId || !tabId || !WORKSPACE_ID_RE.test(workspaceId) || !PANE_ID_RE.test(paneId)) {
    throw new HerdrError('parse', 'herdr returned no pane');
  }
  return { workspaceId, tabId, paneId };
}

function requireWorkspaceId(id: string): string {
  if (!WORKSPACE_ID_RE.test(id)) throw new HerdrError('invalid', 'bad workspace id');
  return id;
}

function requireAgentName(name: string): string {
  if (!isValidAgentName(name)) throw new HerdrError('invalid', 'bad agent name');
  return name;
}

/** An absolute path that can't be mistaken for an option. */
function requirePath(p: string): string {
  if (!(p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) || p.includes('\0')) {
    throw new HerdrError('invalid', 'bad path');
  }
  return p;
}

export function createHerdrClient(opts: HerdrClientOptions): HerdrClient {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = ['--session', opts.session];

  async function run(args: readonly string[], timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) {
    let out: ExecResult;
    try {
      out = await opts.exec(opts.binary, [...base, ...args], timeoutMs);
    } catch (err) {
      throw new HerdrError('exec', err instanceof Error ? err.message : 'exec failed');
    }
    return parseHerdrOutput(out);
  }

  return {
    async isRunning() {
      try {
        const out = await opts.exec(opts.binary, [...base, 'status', 'server', '--json'], 5000);
        const doc = asRecord(JSON.parse(out.stdout.trim() || '{}'));
        const server = asRecord(doc?.server) ?? doc;
        return server?.running === true;
      } catch {
        return false;
      }
    },

    async stopServer() {
      try {
        await opts.exec(opts.binary, [...base, 'server', 'stop'], 10_000);
      } catch {
        // Already gone.
      }
    },

    async installPiIntegration() {
      // Unlike the other commands this one prints a plain line ("installed pi integration to …"),
      // not a JSON document, so success is its exit status alone.
      let out: ExecResult;
      try {
        out = await opts.exec(opts.binary, [...base, 'integration', 'install', 'pi'], opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      } catch (err) {
        throw new HerdrError('exec', err instanceof Error ? err.message : 'exec failed');
      }
      if (out.code !== 0) parseHerdrOutput(out);
    },

    async workspaceCreate(cwd, label) {
      const safeLabel = sanitizeWorkbenchText(label).replace(/\s+/g, ' ').replace(/^-+/, '').slice(0, 40) || 'task';
      const result = await run(['workspace', 'create', '--cwd', requirePath(cwd), '--label', safeLabel, '--no-focus']);
      return paneRef(result);
    },

    async worktreeCreate(repo, branch) {
      if (!isValidWorkbenchBranch(branch)) throw new HerdrError('invalid', 'bad branch');
      const result = await run(['worktree', 'create', '--cwd', requirePath(repo), '--branch', branch, '--no-focus']);
      const ref = paneRef(result);
      const worktree = asRecord(result.worktree);
      const path = str(worktree?.path);
      if (!path) throw new HerdrError('parse', 'herdr returned no worktree path');
      const repoKey = str(asRecord(asRecord(result.workspace)?.worktree)?.repo_key);
      return { ...ref, path, repoKey };
    },

    async workspaceList() {
      const result = await run(['workspace', 'list']);
      const rows = Array.isArray(result.workspaces) ? result.workspaces : [];
      const out: HerdrWorkspaceRow[] = [];
      for (const raw of rows) {
        const row = asRecord(raw);
        const workspaceId = str(row?.workspace_id);
        if (!workspaceId || !WORKSPACE_ID_RE.test(workspaceId)) continue;
        const worktree = asRecord(row?.worktree);
        out.push({
          workspaceId,
          repoKey: str(worktree?.repo_key),
          isLinkedWorktree: worktree?.is_linked_worktree === true,
        });
      }
      return out;
    },

    async workspaceClose(workspaceId) {
      await run(['workspace', 'close', requireWorkspaceId(workspaceId)]);
    },

    async worktreeRemove(workspaceId) {
      await run(['worktree', 'remove', '--workspace', requireWorkspaceId(workspaceId)]);
    },

    async agentStart(name, paneId, piArgs) {
      if (!PANE_ID_RE.test(paneId)) throw new HerdrError('invalid', 'bad pane id');
      const args = ['agent', 'start', requireAgentName(name), '--kind', 'pi', '--pane', paneId, '--', ...piArgs];
      for (let attempt = 0; ; attempt += 1) {
        try {
          await run(args, AGENT_START_TIMEOUT_MS);
          return;
        } catch (err) {
          const busy = err instanceof HerdrError && err.code === 'agent_pane_busy';
          if (!busy || attempt >= PANE_BUSY_RETRIES) throw err;
          await sleep(PANE_BUSY_DELAY_MS);
        }
      }
    },

    async agentPrompt(name, text) {
      const message = promptText(text);
      if (message === '') throw new HerdrError('invalid', 'empty prompt');
      await run(['agent', 'prompt', requireAgentName(name), message]);
    },

    async agentList() {
      const result = await run(['agent', 'list']);
      const rows = Array.isArray(result.agents) ? result.agents : [];
      const out: HerdrAgentRow[] = [];
      for (const raw of rows) {
        const row = asRecord(raw);
        const name = str(row?.name);
        if (!name) continue;
        out.push({
          name,
          status: toHerdrAgentStatus(row?.agent_status),
          workspaceId: str(row?.workspace_id),
        });
      }
      return out;
    },

    async agentRead(name, lines) {
      const n = Math.max(1, Math.min(500, Math.floor(lines)));
      const args = [...base, 'agent', 'read', requireAgentName(name), '--source', 'recent-unwrapped', '--lines', String(n)];
      let out: ExecResult;
      try {
        out = await opts.exec(opts.binary, args, 10_000);
      } catch (err) {
        throw new HerdrError('exec', err instanceof Error ? err.message : 'exec failed');
      }
      // `agent read` prints plain text; only a failure is JSON.
      if (out.code !== 0) parseHerdrOutput(out);
      return out.stdout;
    },
  };
}

/** Where to look for a CLI when the app was launched from the Finder (minimal PATH). */
export function candidateBinDirs(pathEnv: string | undefined, homeDir: string, delimiter = ':'): string[] {
  const dirs = [
    ...(pathEnv ?? '').split(delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${homeDir}/.local/bin`,
    `${homeDir}/.cargo/bin`,
    '/usr/bin',
  ].filter((d) => d.startsWith('/'));
  return [...new Set(dirs)];
}

/** Resolve a binary name to the first executable candidate, or null. */
export function findBinary(
  name: string,
  dirs: readonly string[],
  isExecutable: (file: string) => boolean,
): string | null {
  for (const dir of dirs) {
    const file = `${dir.replace(/\/+$/, '')}/${name}`;
    if (isExecutable(file)) return file;
  }
  return null;
}
