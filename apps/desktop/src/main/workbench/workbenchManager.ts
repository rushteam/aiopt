// Workbench manager — the state machine behind the Workbench screen.
//
// It owns three things:
//   - the ORCHESTRATOR: one headless `pi --mode rpc` child the user chats with. Its transcript
//     is folded from pi's events (piEvents.ts); its `propose_tasks` calls become task cards;
//   - AiOpt's own herdr session (`herdr --session aiopt server`), where each approved task
//     runs as an interactive pi WORKER in its own workspace (optionally a fresh git worktree),
//     which the user can attach to from any terminal;
//   - the task board and the granted folders.
//
// What persists in `<dataDir>` (docs/dev-rules/credentials-and-local-storage.md §2):
//   - `folders.json`: the granted folders;
//   - `tasks.json`: the board. It is also the coordinator's view of the board (its `list_tasks`
//     tool and the `/aiopt-task-update` command read it), so it carries a short brief and the
//     tail of a worker's terminal captured when the task stopped for review or input. Tasks that
//     were live come back `stopped` (their workers ended with the old herdr server);
//   - `sessions/`: pi's own session files, one per conversation, so "new conversation" keeps
//     the old one and the last one reopens on start. The renderer names a conversation by the
//     uuid in a file name main listed itself, never by a path;
//   - `settings.json`: the user's workbench preferences, overrides only.
//
// Security notes (docs/dev-rules/electron-security-and-process-boundaries.md,
// credentials-and-local-storage.md):
//   - every binary, argv and path is built here from main-side state. The renderer names a
//     task or folder by an opaque id minted here; folders enter only through the main-side
//     picker (`addFolder` is called by the IPC layer with the dialog's result);
//   - the model credential (the proxy route token, or the provider key for a direct binding)
//     reaches the children through their ENVIRONMENT only (`AIOPT_WB_KEY`, which pi's
//     models.json references as `$AIOPT_WB_KEY`). It is never written to disk, never put in an
//     argv (visible in `ps`), never logged, and never part of the snapshot;
//   - the orchestrator gets only read-only tools, confined to the granted folders by its
//     extension (orchestratorExtension.ts). Workers are full coding agents: they run with the
//     user's permissions in the folder the user approved, like running pi by hand there.
//
// Electron-free: every side effect goes through the injected deps, so it unit-tests with fakes.

import path from 'node:path';
import {
  DEFAULT_WORKBENCH_SETTINGS,
  WORKBENCH_HERDR_SESSION,
  WORKBENCH_LIMITS,
  branchSlugFor,
  isLiveTaskStatus,
  isTaskStatus,
  isValidConversationId,
  isValidWorkbenchBranch,
  isValidWorkbenchId,
  sanitizeWorkbenchText,
  type ConversationView,
  type FolderView,
  type TaskFailure,
  type TaskOrigin,
  type TaskStatus,
  type TaskView,
  type WorkbenchIssue,
  type WorkbenchModel,
  type WorkbenchSettings,
  type WorkbenchSnapshot,
  type WorkbenchStatus,
} from '../../shared/workbench';
import { throwIpcError } from '../ipc/validate';
import type { Logger } from '../logger';
import { homeRelativeDisplayPath } from '../displayPath';
import {
  candidateBinDirs,
  createHerdrClient,
  HerdrError,
  type ExecResult,
  type HerdrClient,
  type HerdrClientOptions,
} from './herdrCli';
import { createPiRpcClient, type PiChild, type PiRpcClient } from './piRpc';
import { createTranscript, type ProposedTask } from './piEvents';
import {
  dependenciesMet as depsMet,
  normalizeDependsOnIds,
  wouldCreateCycle,
} from './taskDepends';
import { nextTaskStatus, taskAllows, type TaskAction } from './taskModel';
import {
  FOLDERS_FILE_ENV,
  ORCHESTRATOR_EXTENSION_SOURCE,
  ORCHESTRATOR_SYSTEM_PROMPT,
  ORCHESTRATOR_TOOLS,
  TASKS_FILE_ENV,
  TASK_UPDATE_COMMAND,
} from './orchestratorExtension';

/** The model the workbench agents use, resolved main-side from pi's binding in Providers. */
export interface ResolvedWorkbenchModel {
  view: WorkbenchModel;
  baseUrl: string;
  /** pi's model-adapter id (`openai-completions`, `anthropic-messages`, …). */
  api: string;
  /** The name sent on the wire. */
  modelId: string;
  /** SECRET-CLASS: the route token or provider key. Env only; never disk, argv, log or IPC. */
  key: string;
}

export interface WorkbenchFs {
  mkdirp(dir: string): void;
  /** Atomic write (temp + rename). */
  writeFile(file: string, contents: string): void;
  /** File contents, or null when missing/unreadable. */
  readFile(file: string): string | null;
  isDirectory(p: string): boolean;
  /** Canonical absolute path, or null when it does not exist. */
  realpath(p: string): string | null;
  /** Entry names in a directory ([] when missing). */
  listDir(dir: string): string[];
  /** Size and mtime of a regular file (not following a symlink), or null. */
  statFile(file: string): { size: number; mtimeMs: number } | null;
  /** Up to `maxBytes` from the start of a file, or null when unreadable. */
  readFileHead(file: string, maxBytes: number): string | null;
  removeFile(file: string): void;
}

export interface WorkbenchDeps {
  platform: NodeJS.Platform;
  /** `<userData>/workbench`. */
  dataDir: string;
  homeDir: string;
  /** The launching environment (only an allowlist of it is passed on). */
  env: Readonly<Record<string, string | undefined>>;
  fs: WorkbenchFs;
  /** Resolve a CLI name to an executable path, or null. */
  findBinary(name: 'pi' | 'herdr' | 'git', dirs: readonly string[]): string | null;
  resolveModel(): ResolvedWorkbenchModel | null;
  /** execFile (no shell). Resolves on a non-zero exit. */
  exec(file: string, args: readonly string[], timeoutMs: number, env: Record<string, string>): Promise<ExecResult>;
  /** Spawn a detached, unref'd process with stdio ignored (outlives AiOpt if it must). */
  spawnDetached(file: string, args: readonly string[], env: Record<string, string>, cwd: string): void;
  /** Spawn the orchestrator with piped stdio. */
  spawnPi(file: string, args: readonly string[], env: Record<string, string>, cwd: string): PiChild;
  /** Whether a folder is inside a git work tree. */
  isGitRepo(dir: string): Promise<boolean>;
  onChange(): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Run `fn` every `ms`; returns a canceller. */
  every(ms: number, fn: () => void): () => void;
  /** A fresh id matching `[a-z0-9]{10}`. */
  randomId(): string;
  logger: Logger;
  /** Test seam; defaults to the real CLI client over `exec`. */
  createHerdr?: (opts: HerdrClientOptions) => HerdrClient;
}

export interface TaskDraft {
  title: string;
  prompt: string;
  folderId?: string | null;
  isolated?: boolean;
  dependsOn?: string[] | null;
}

export interface WorkbenchManager {
  getSnapshot(): WorkbenchSnapshot;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Best-effort, non-blocking teardown for app quit. */
  shutdown(): void;
  chatSend(text: string): Promise<void>;
  chatAbort(): Promise<void>;
  chatReset(): Promise<void>;
  /** `dir` comes from the main-side folder picker, never from the renderer. */
  addFolder(dir: string): Promise<void>;
  removeFolder(folderId: string): void;
  createTask(draft: TaskDraft): string;
  updateTask(taskId: string, patch: Partial<TaskDraft>): void;
  launchTask(taskId: string): void;
  messageTask(taskId: string, text: string): Promise<void>;
  completeTask(taskId: string): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  removeTask(taskId: string): Promise<void>;
  taskOutput(taskId: string): Promise<string>;
  /** Launch every proposed task that has a folder, up to the live limit; returns how many. */
  runAll(): number;
  /** Reopen a past conversation, named by the id `getSnapshot().conversations` listed. */
  openConversation(conversationId: string): Promise<void>;
  deleteConversation(conversationId: string): void;
  updateSettings(patch: Partial<WorkbenchSettings>): void;
}

/** The provider slug the workbench's own pi config defines. */
export const WORKBENCH_PI_PROVIDER = 'aiopt-wb';
export const WORKBENCH_KEY_ENV = 'AIOPT_WB_KEY';

/** How often herdr is asked for the workers' state. */
export const POLL_MS = 3000;
const SERVER_READY_TRIES = 40;
const SERVER_READY_DELAY_MS = 250;
/** Task changes that land together reach the coordinator as one update. */
export const NOTIFY_DEBOUNCE_MS = 1500;
/** How much of a session file is read for its title (the first user message is near the top). */
const SESSION_HEAD_BYTES = 32 * 1024;
/** A task's brief as the coordinator sees it on the board (the full prompt stays with the task). */
const TASK_BRIEF_CHARS = 600;
/** pi's session file name: `<ISO time with - for :>_<uuid>.jsonl`. */
const SESSION_FILE_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
/** Statuses the coordinator is told about (the user may want to act on them). */
const NOTIFY_STATUSES: readonly TaskStatus[] = ['review', 'blocked', 'failed'];
const TASK_ORIGINS: readonly TaskOrigin[] = ['orchestrator', 'user'];
const TASK_FAILURES: readonly TaskFailure[] = ['herdr_error', 'folder_missing', 'agent_lost'];

/**
 * Worker pi flags: ignore project-local `.pi` files (a repo must not be able to load code into
 * the worker just by being opened) and skip startup network calls. The model comes from the
 * workbench's own settings.json, so nothing secret or model-specific is on the command line.
 */
export const WORKER_PI_ARGS: readonly string[] = ['--no-approve', '--offline'];

/** Variables carried over from the launching environment. Everything else is dropped. */
const ENV_ALLOWLIST = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TERM',
  'COLORTERM',
  'SSH_AUTH_SOCK',
] as const;

interface FolderRecord {
  id: string;
  name: string;
  path: string;
  isGitRepo: boolean;
}

interface TaskRecord {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  origin: TaskOrigin;
  folderId: string | null;
  isolated: boolean;
  branch: string | null;
  agentName: string | null;
  failure: TaskFailure | null;
  createdAt: number;
  updatedAt: number;
  /** herdr workspace hosting the worker, while one is open. */
  workspaceId: string | null;
  /** Absolute worktree checkout, when isolated and created. */
  worktreePath: string | null;
  /** The repo the worktree belongs to (the folder's path at launch). */
  worktreeRepo: string | null;
  repoKey: string | null;
  /** When the worker was last given a message (for the idle grace window). */
  promptAt: number;
  /** The worker's terminal tail when it last stopped for review or input (for the coordinator). */
  outputTail: string;
  dependsOn: string[];
}

interface TasksDoc {
  version: 1;
  tasks: {
    id: string;
    title: string;
    status: TaskStatus;
    origin: TaskOrigin;
    folderId: string | null;
    /** The folder's name, for the coordinator. */
    folder: string | null;
    isolated: boolean;
    branch: string | null;
    failure: TaskFailure | null;
    /** The start of the prompt, for the coordinator. */
    brief: string;
    prompt: string;
    output: string;
    worktreePath: string | null;
    worktreeRepo: string | null;
    repoKey: string | null;
    createdAt: number;
    updatedAt: number;
    dependsOn?: string[];
  }[];
}

interface ConversationRecord {
  id: string;
  file: string;
  title: string;
  updatedAt: number;
}

interface FoldersDoc {
  version: 1;
  folders: { id: string; name: string; path: string; git: boolean }[];
}

function errorCode(err: unknown): string {
  if (err instanceof HerdrError) return err.code;
  return err instanceof Error ? err.name : 'unknown';
}

export function createWorkbenchManager(deps: WorkbenchDeps): WorkbenchManager {
  const log = deps.logger;
  const piAgentDir = path.join(deps.dataDir, 'pi-agent');
  const orchestratorCwd = path.join(deps.dataDir, 'orchestrator');
  const extensionFile = path.join(deps.dataDir, 'orchestrator-extension.mjs');
  const foldersFile = path.join(deps.dataDir, 'folders.json');
  const tasksFile = path.join(deps.dataDir, 'tasks.json');
  const settingsFile = path.join(deps.dataDir, 'settings.json');
  const sessionsDir = path.join(deps.dataDir, 'sessions');

  let status: WorkbenchStatus = 'stopped';
  let issue: WorkbenchIssue | null = null;
  let model: WorkbenchModel | null = null;
  let rpc: PiRpcClient | null = null;
  let herdr: HerdrClient | null = null;
  let herdrBinary: string | null = null;
  let gitBinary: string | null = null;
  let cliEnv: Record<string, string> = {};
  /** Whether THIS process started the aiopt herdr server (so a restart may reuse it). */
  let ownsServer = false;
  let cancelPoll: (() => void) | null = null;
  let polling = false;
  let startSeq = 0;
  const launching = new Set<string>();
  const transcript = createTranscript();
  let folders: FolderRecord[] = loadFolders();
  const tasks = new Map<string, TaskRecord>(loadTasks().map((t) => [t.id, t]));
  let tasksSignature = signatureOf();
  let settingsDoc: Record<string, unknown> = readJson(settingsFile);
  let settings: WorkbenchSettings = settingsFrom(settingsDoc);
  let conversations: ConversationRecord[] = listConversations();
  /** Basename of the session file the coordinator is in now. */
  let currentSession: string | null = null;
  /** Whether the coordinator's current turn answers the user (auto-run applies only then). */
  let userTurn = false;
  const pendingNotify = new Set<string>();
  let notifyScheduled = false;

  /** Every change goes through here; the board is written whenever it actually moved. */
  function changed(): void {
    const next = signatureOf();
    if (next !== tasksSignature) {
      tasksSignature = next;
      saveTasks();
    }
    deps.onChange();
  }

  // --- folders --------------------------------------------------------------------------

  function loadFolders(): FolderRecord[] {
    const text = deps.fs.readFile(foldersFile);
    if (!text) return [];
    try {
      const doc = JSON.parse(text) as Partial<FoldersDoc>;
      if (!Array.isArray(doc.folders)) return [];
      const out: FolderRecord[] = [];
      for (const raw of doc.folders) {
        // Records on disk are re-validated, not trusted: a bad one is dropped.
        if (
          !raw ||
          typeof raw.id !== 'string' ||
          !/^[a-z0-9]{1,32}$/.test(raw.id) ||
          typeof raw.path !== 'string' ||
          !path.isAbsolute(raw.path) ||
          out.some((f) => f.id === raw.id || f.path === raw.path)
        ) {
          continue;
        }
        out.push({ id: raw.id, name: path.basename(raw.path) || raw.path, path: raw.path, isGitRepo: raw.git === true });
        if (out.length >= WORKBENCH_LIMITS.folders) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  function saveFolders(): void {
    try {
      deps.fs.mkdirp(deps.dataDir);
      deps.fs.writeFile(foldersFile, `${JSON.stringify(foldersDoc(), null, 2)}\n`);
      saveTasks();
    } catch (err) {
      log.error('workbench.folders_write_failed', { code: errorCode(err) });
      throwIpcError('INTERNAL', 'could not save folders');
    }
  }

  /** Also the orchestrator extension's grant list (it re-reads the file on every tool call). */
  function foldersDoc(): FoldersDoc {
    return {
      version: 1,
      folders: folders.map((f) => ({ id: f.id, name: f.name, path: f.path, git: f.isGitRepo })),
    };
  }

  function folderById(id: string | null): FolderRecord | null {
    return id ? (folders.find((f) => f.id === id) ?? null) : null;
  }

  /** Map the orchestrator's folder hint to a granted folder. */
  function folderForHint(hint: string | null): string | null {
    if (hint) {
      const lower = hint.toLowerCase();
      const hit = folders.find((f) => f.name.toLowerCase() === lower || f.path === hint);
      if (hit) return hit.id;
    }
    return folders.length === 1 ? folders[0]!.id : null;
  }

  // --- task board file ------------------------------------------------------------------

  function signatureOf(): string {
    // Cheap to compute on every change (streamed chat events included); covers every field
    // a mutation touches.
    let sig = '';
    for (const t of tasks.values()) {
      sig += `${t.id}|${t.status}|${t.updatedAt}|${t.folderId}|${t.isolated}|${t.branch}|${t.failure}|`;
      sig += `${t.worktreePath}|${t.title}|${t.prompt.length}|${t.outputTail.length}|${t.dependsOn.join(',')};`;
    }
    return sig;
  }

  function absOrNull(value: unknown): string | null {
    return typeof value === 'string' && path.isAbsolute(value) ? value : null;
  }

  function loadTasks(): TaskRecord[] {
    const text = deps.fs.readFile(tasksFile);
    if (!text) return [];
    try {
      const doc = JSON.parse(text) as Partial<TasksDoc>;
      if (!Array.isArray(doc.tasks)) return [];
      const out: TaskRecord[] = [];
      const dependsRaw = new Map<string, unknown>();
      for (const raw of doc.tasks as unknown[]) {
        // Re-validated like folders.json: a record that does not fit is dropped or narrowed.
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        if (!isValidWorkbenchId(r.id) || out.some((t) => t.id === r.id)) continue;
        if (typeof r.title !== 'string' || typeof r.prompt !== 'string' || !isTaskStatus(r.status)) continue;
        const title = cleanTitle(r.title);
        const prompt = cleanPrompt(r.prompt);
        if (title === '' || prompt === '') continue;
        const folderId = typeof r.folderId === 'string' && folderById(r.folderId) ? r.folderId : null;
        const worktreePath = absOrNull(r.worktreePath);
        const worktreeRepo = worktreePath ? absOrNull(r.worktreeRepo) : null;
        const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : deps.now();
        const updatedAt = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : createdAt;
        out.push({
          id: r.id,
          title,
          prompt,
          // A worker does not survive the app: whatever was live is stopped now.
          status: isLiveTaskStatus(r.status) ? 'stopped' : r.status,
          origin: TASK_ORIGINS.includes(r.origin as TaskOrigin) ? (r.origin as TaskOrigin) : 'user',
          folderId,
          isolated: r.isolated === true,
          branch: isValidWorkbenchBranch(r.branch) ? r.branch : null,
          agentName: null,
          failure: TASK_FAILURES.includes(r.failure as TaskFailure) ? (r.failure as TaskFailure) : null,
          createdAt,
          updatedAt,
          workspaceId: null,
          worktreePath,
          worktreeRepo,
          repoKey: worktreePath && typeof r.repoKey === 'string' ? r.repoKey : null,
          promptAt: 0,
          outputTail:
            typeof r.output === 'string' ? sanitizeWorkbenchText(r.output).slice(-WORKBENCH_LIMITS.taskOutputTail) : '',
          dependsOn: [],
        });
        dependsRaw.set(r.id as string, r.dependsOn);
        if (out.length >= WORKBENCH_LIMITS.tasks) break;
      }
      const ids = new Set(out.map((x) => x.id));
      for (const t of out) {
        t.dependsOn = normalizeDependsOnIds(dependsRaw.get(t.id), ids, t.id);
      }
      return out;
    } catch {
      return [];
    }
  }

  function tasksDoc(): TasksDoc {
    return {
      version: 1,
      tasks: [...tasks.values()].map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        origin: t.origin,
        folderId: t.folderId,
        folder: folderById(t.folderId)?.name ?? null,
        isolated: t.isolated,
        branch: t.branch,
        failure: t.failure,
        brief: t.prompt.replace(/\s+/g, ' ').slice(0, TASK_BRIEF_CHARS),
        prompt: t.prompt,
        output: t.outputTail,
        worktreePath: t.worktreePath,
        worktreeRepo: t.worktreeRepo,
        repoKey: t.repoKey,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        dependsOn: t.dependsOn,
      })),
    };
  }

  function taskStatusMap(): Map<string, { status: TaskStatus }> {
    return new Map([...tasks.entries()].map(([id, t]) => [id, { status: t.status }]));
  }

  function dependencyEdges(excludeId?: string): Map<string, readonly string[]> {
    const edges = new Map<string, readonly string[]>();
    for (const t of tasks.values()) {
      if (t.id !== excludeId) edges.set(t.id, t.dependsOn);
    }
    return edges;
  }

  function assignDependsOn(taskId: string, raw: string[]): void {
    const known = new Set(tasks.keys());
    const dependsOn = normalizeDependsOnIds(raw, known, taskId);
    if (wouldCreateCycle(taskId, dependsOn, dependencyEdges(taskId))) {
      throwIpcError('INVALID_PARAMS', 'task dependencies would cycle');
    }
    tasks.get(taskId)!.dependsOn = dependsOn;
  }

  function resolveProposalDepends(p: ProposedTask, batch: readonly { id: string; title: string }[]): string[] {
    const ids: string[] = [...p.dependsOnIds.filter((id) => tasks.has(id))];
    const titleToId = new Map(batch.map((b) => [b.title.toLowerCase(), b.id]));
    for (const title of p.dependsOnTitles) {
      const hit = titleToId.get(title.toLowerCase());
      if (hit && !ids.includes(hit)) ids.push(hit);
    }
    return ids;
  }

  function maybeLaunchDependents(finishedId: string): void {
    if (!settings.autoLaunchDependents) return;
    for (const t of tasks.values()) {
      if (t.dependsOn.includes(finishedId) && canLaunch(t)) launchTask(t.id);
    }
  }

  function saveTasks(): void {
    try {
      deps.fs.mkdirp(deps.dataDir);
      deps.fs.writeFile(tasksFile, `${JSON.stringify(tasksDoc(), null, 2)}\n`);
    } catch (err) {
      // The board keeps working in memory; the next change tries again.
      log.error('workbench.tasks_write_failed', { code: errorCode(err) });
      tasksSignature = '';
    }
  }

  // --- settings -------------------------------------------------------------------------

  function settingsFrom(doc: Record<string, unknown>): WorkbenchSettings {
    // Validated on load; anything else falls back to the default.
    return {
      autoRun: typeof doc.autoRun === 'boolean' ? doc.autoRun : DEFAULT_WORKBENCH_SETTINGS.autoRun,
      notifyCoordinator:
        typeof doc.notifyCoordinator === 'boolean' ? doc.notifyCoordinator : DEFAULT_WORKBENCH_SETTINGS.notifyCoordinator,
      autoLaunchDependents:
        typeof doc.autoLaunchDependents === 'boolean'
          ? doc.autoLaunchDependents
          : DEFAULT_WORKBENCH_SETTINGS.autoLaunchDependents,
    };
  }

  function updateSettings(patch: Partial<WorkbenchSettings>): void {
    // Only overrides are stored: a value equal to the default removes its key. Keys this build
    // does not know are kept.
    const next: Record<string, unknown> = { ...readJson(settingsFile) };
    for (const key of ['autoRun', 'notifyCoordinator', 'autoLaunchDependents'] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value === DEFAULT_WORKBENCH_SETTINGS[key]) delete next[key];
      else next[key] = value;
    }
    try {
      deps.fs.mkdirp(deps.dataDir);
      deps.fs.writeFile(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
    } catch (err) {
      log.error('workbench.settings_write_failed', { code: errorCode(err) });
      throwIpcError('INTERNAL', 'could not save settings');
    }
    settingsDoc = next;
    settings = settingsFrom(settingsDoc);
    if (!settings.notifyCoordinator) pendingNotify.clear();
    changed();
  }

  // --- conversations --------------------------------------------------------------------

  function titleOf(file: string): string {
    const head = deps.fs.readFileHead(file, SESSION_HEAD_BYTES);
    if (!head) return '';
    for (const line of head.split('\n')) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // Includes a line cut off by the byte cap.
      }
      const record = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null;
      if (record?.type !== 'message' || record.message?.role !== 'user') continue;
      const content = record.message.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join(' ')
            : '';
      const title = sanitizeWorkbenchText(text).replace(/\s+/g, ' ').trim();
      if (title !== '') return title.slice(0, WORKBENCH_LIMITS.conversationTitle);
    }
    return '';
  }

  /** The session files pi wrote, newest first. Only names pi itself produces are accepted. */
  function listConversations(): ConversationRecord[] {
    const out: ConversationRecord[] = [];
    for (const name of deps.fs.listDir(sessionsDir)) {
      const match = SESSION_FILE_RE.exec(name);
      if (!match) continue;
      const file = path.join(sessionsDir, name);
      const stat = deps.fs.statFile(file);
      if (!stat) continue;
      out.push({ id: match[1]!, file, title: '', updatedAt: stat.mtimeMs });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    const listed = out.slice(0, WORKBENCH_LIMITS.conversations);
    for (const c of listed) c.title = titleOf(c.file);
    return listed;
  }

  function refreshConversations(): void {
    conversations = listConversations();
  }

  function requireConversation(conversationId: string): ConversationRecord {
    if (!isValidConversationId(conversationId)) throwIpcError('INVALID_PARAMS', 'invalid conversation id');
    refreshConversations();
    const hit = conversations.find((c) => c.id === conversationId);
    if (!hit) throwIpcError('NOT_FOUND', 'conversation not found');
    return hit;
  }

  async function trackSession(client: PiRpcClient): Promise<void> {
    try {
      const state = await client.getState();
      currentSession = state.sessionFile ? path.basename(state.sessionFile) : null;
    } catch (err) {
      log.debug('workbench.state_failed', { code: errorCode(err) });
      currentSession = null;
    }
  }

  /** Rebuild the transcript from the session pi is in now. */
  async function loadTranscript(client: PiRpcClient): Promise<void> {
    try {
      transcript.load(await client.getMessages());
    } catch (err) {
      log.warn('workbench.messages_failed', { code: errorCode(err) });
      transcript.clear();
    }
  }

  // --- snapshot -------------------------------------------------------------------------

  function taskView(t: TaskRecord): TaskView {
    return {
      id: t.id,
      title: t.title,
      prompt: t.prompt,
      status: t.status,
      origin: t.origin,
      folderId: t.folderId,
      isolated: t.isolated,
      branch: t.branch,
      worktreeDisplay: t.worktreePath ? homeRelativeDisplayPath(t.worktreePath, deps.homeDir) : null,
      agentName: t.agentName,
      failure: t.failure,
      dependsOn: [...t.dependsOn],
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  function folderView(f: FolderRecord): FolderView {
    return { id: f.id, name: f.name, displayPath: homeRelativeDisplayPath(f.path, deps.homeDir), isGitRepo: f.isGitRepo };
  }

  function conversationView(c: ConversationRecord): ConversationView {
    return { id: c.id, title: c.title, updatedAt: c.updatedAt, current: path.basename(c.file) === currentSession };
  }

  function getSnapshot(): WorkbenchSnapshot {
    return {
      status,
      issue,
      model,
      streaming: transcript.streaming(),
      chat: transcript.items(),
      tasks: [...tasks.values()].map(taskView),
      folders: folders.map(folderView),
      herdrSession: WORKBENCH_HERDR_SESSION,
      herdrAvailable: herdr !== null,
      conversations: conversations.map(conversationView),
      settings: { ...settings },
    };
  }

  // --- environment + files --------------------------------------------------------------

  function baseEnv(binDirs: readonly string[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of ENV_ALLOWLIST) {
      const value = deps.env[name];
      if (typeof value === 'string' && value !== '') env[name] = value;
    }
    env.PATH = binDirs.join(':');
    env.PI_CODING_AGENT_DIR = piAgentDir;
    env.PI_OFFLINE = '1';
    env.PI_SKIP_VERSION_CHECK = '1';
    env.PI_TELEMETRY = '0';
    return env;
  }

  function readJson(file: string): Record<string, unknown> {
    const text = deps.fs.readFile(file);
    if (!text) return {};
    try {
      const doc = JSON.parse(text) as unknown;
      return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** The workbench's own pi config dir — never the user's `~/.pi/agent`. */
  function writePiConfig(resolved: ResolvedWorkbenchModel): void {
    deps.fs.mkdirp(path.join(piAgentDir, 'extensions'));
    deps.fs.mkdirp(orchestratorCwd);
    deps.fs.mkdirp(sessionsDir);
    const models = {
      providers: {
        [WORKBENCH_PI_PROVIDER]: {
          baseUrl: resolved.baseUrl,
          api: resolved.api,
          // An env reference, resolved by pi at request time: the credential is not on disk.
          apiKey: `$${WORKBENCH_KEY_ENV}`,
          models: [{ id: resolved.modelId }],
        },
      },
    };
    deps.fs.writeFile(path.join(piAgentDir, 'models.json'), `${JSON.stringify(models, null, 2)}\n`);
    // pi writes its own keys here too (e.g. lastChangelogVersion); only ours are replaced.
    const piSettingsFile = path.join(piAgentDir, 'settings.json');
    const piSettings = {
      ...readJson(piSettingsFile),
      defaultProvider: WORKBENCH_PI_PROVIDER,
      defaultModel: resolved.modelId,
      quietStartup: true,
      collapseChangelog: true,
    };
    deps.fs.writeFile(piSettingsFile, `${JSON.stringify(piSettings, null, 2)}\n`);
    deps.fs.writeFile(extensionFile, ORCHESTRATOR_EXTENSION_SOURCE);
  }

  // --- lifecycle ------------------------------------------------------------------------

  function setStatus(next: WorkbenchStatus, nextIssue: WorkbenchIssue | null): void {
    status = next;
    issue = nextIssue;
    changed();
  }

  function stopPolling(): void {
    cancelPoll?.();
    cancelPoll = null;
  }

  function disposeOrchestrator(): void {
    const client = rpc;
    rpc = null;
    client?.dispose();
  }

  /** Every live task is ended (its worker is gone with the server). */
  function endLiveTasks(): void {
    for (const t of tasks.values()) {
      if (isLiveTaskStatus(t.status)) {
        t.status = 'stopped';
        t.workspaceId = null;
        t.updatedAt = deps.now();
      }
    }
    launching.clear();
  }

  async function startServer(client: HerdrClient, binary: string, env: Record<string, string>): Promise<void> {
    if (await client.isRunning()) {
      if (ownsServer) return;
      // Left over from a previous run that did not shut down cleanly: its environment
      // (and credential) may be stale, and none of its workers belong to a task here.
      log.warn('workbench.stale_server');
      await client.stopServer();
    }
    deps.spawnDetached(binary, ['--session', WORKBENCH_HERDR_SESSION, 'server'], env, deps.homeDir);
    for (let i = 0; i < SERVER_READY_TRIES; i += 1) {
      if (await client.isRunning()) {
        ownsServer = true;
        return;
      }
      await deps.sleep(SERVER_READY_DELAY_MS);
    }
    throw new HerdrError('timeout', 'herdr server did not start');
  }

  async function start(): Promise<void> {
    if (status === 'starting' || status === 'ready') return;
    const seq = (startSeq += 1);
    transcript.clear();
    model = null;
    currentSession = null;
    userTurn = false;
    if (deps.platform === 'win32') {
      setStatus('error', 'unsupported_platform');
      return;
    }
    setStatus('starting', null);

    const dirs = candidateBinDirs(deps.env.PATH, deps.homeDir);
    const piBinary = deps.findBinary('pi', dirs);
    if (!piBinary) {
      setStatus('error', 'pi_missing');
      return;
    }
    const resolved = deps.resolveModel();
    if (!resolved) {
      setStatus('error', 'no_binding');
      return;
    }
    model = resolved.view;
    herdrBinary = deps.findBinary('herdr', dirs);
    gitBinary = deps.findBinary('git', dirs);

    // pi is a node script (`#!/usr/bin/env node`): its own dir goes first so the node it was
    // installed with is found even from a Finder launch's minimal PATH.
    const binDirs = [
      ...new Set([path.dirname(piBinary), ...(herdrBinary ? [path.dirname(herdrBinary)] : []), ...dirs]),
    ];
    cliEnv = baseEnv(binDirs);
    const agentEnv = { ...cliEnv, [WORKBENCH_KEY_ENV]: resolved.key || 'none' };

    try {
      writePiConfig(resolved);
      deps.fs.writeFile(foldersFile, `${JSON.stringify(foldersDoc(), null, 2)}\n`);

      const child = deps.spawnPi(
        piBinary,
        [
          '--mode',
          'rpc',
          '--session-dir',
          sessionsDir,
          '--no-extensions',
          '--extension',
          extensionFile,
          '--no-skills',
          '--no-prompt-templates',
          '--no-themes',
          '--no-context-files',
          '--no-approve',
          '--offline',
          '--tools',
          ORCHESTRATOR_TOOLS.join(','),
          '--append-system-prompt',
          ORCHESTRATOR_SYSTEM_PROMPT,
        ],
        { ...agentEnv, [FOLDERS_FILE_ENV]: foldersFile, [TASKS_FILE_ENV]: tasksFile },
        orchestratorCwd,
      );
      const client = createPiRpcClient(child, {
        onEvent: (event) => onOrchestratorEvent(event),
        onExit: (code) => onOrchestratorExit(client, code),
      });
      rpc = client;
      await client.ping();
      if (seq !== startSeq) return;
      await resumeLatest(client);
      if (seq !== startSeq) return;

      if (herdrBinary) {
        const binary = herdrBinary;
        const hc = (deps.createHerdr ?? createHerdrClient)({
          binary,
          session: WORKBENCH_HERDR_SESSION,
          exec: (file, args, timeoutMs) => deps.exec(file, args, timeoutMs, cliEnv),
          sleep: deps.sleep,
        });
        try {
          await startServer(hc, binary, agentEnv);
          // The pi integration lets herdr see each worker's state; it installs into the
          // workbench's own pi agent dir (created above), not the user's.
          await hc.installPiIntegration();
          herdr = hc;
        } catch (err) {
          // Chat still works without herdr; tasks just can't launch.
          log.warn('workbench.herdr_unavailable', { code: errorCode(err) });
          herdr = null;
        }
      }
      if (seq !== startSeq) {
        // stop() ran while this start was in flight: undo what came up after it.
        if (herdr) await herdr.stopServer();
        herdr = null;
        ownsServer = false;
        return;
      }
      setStatus('ready', null);
      cancelPoll = deps.every(POLL_MS, () => void poll());
      log.info('workbench.started', { herdr: herdr !== null, proxied: resolved.view.proxied });
    } catch (err) {
      log.error('workbench.start_failed', { code: errorCode(err) });
      disposeOrchestrator();
      if (seq === startSeq) setStatus('error', 'start_failed');
    }
  }

  /**
   * Reopen the most recent conversation. pi starts fresh and switches over RPC, so a damaged
   * session file costs only the reopen, never the start.
   */
  async function resumeLatest(client: PiRpcClient): Promise<void> {
    refreshConversations();
    const latest = conversations[0];
    if (latest) {
      try {
        await client.switchSession(latest.file);
        await loadTranscript(client);
      } catch (err) {
        log.warn('workbench.resume_failed', { code: errorCode(err) });
        transcript.clear();
      }
    }
    await trackSession(client);
  }

  function onOrchestratorExit(client: PiRpcClient, code: number | null): void {
    if (rpc !== client) return; // A deliberate dispose.
    rpc = null;
    log.warn('workbench.orchestrator_exited', { code: code ?? undefined });
    stopPolling();
    transcript.apply({ type: 'agent_settled' });
    setStatus('error', 'orchestrator_exited');
  }

  function onOrchestratorEvent(event: Record<string, unknown>): void {
    if (event.type === 'message_start') {
      // A turn started by a user message may auto-run; one started by a task update may not
      // (its input includes worker output, which is untrusted).
      const role = (event.message as { role?: unknown } | null)?.role;
      if (role === 'user') userTurn = true;
      else if (role === 'custom') userTurn = false;
    }
    const effects = transcript.apply(event);
    if (effects.proposed.length > 0) addProposals(effects.proposed);
    if (effects.launchTaskIds.length > 0) applyLaunchRequests(effects.launchTaskIds);
    // pi saves the session as the turn ends: that is when a new conversation appears.
    if (event.type === 'agent_end') refreshConversations();
    changed();
  }

  function addProposals(proposed: readonly ProposedTask[]): void {
    let dropped = false;
    const added: string[] = [];
    const batch: { id: string; title: string }[] = [];
    for (const p of proposed) {
      if (tasks.size >= WORKBENCH_LIMITS.tasks) {
        dropped = true;
        break;
      }
      const id = insertTask(p.title, p.prompt, 'orchestrator', folderForHint(p.folder), false);
      batch.push({ id, title: p.title });
      added.push(id);
    }
    for (let i = 0; i < proposed.length && i < batch.length; i += 1) {
      const ids = resolveProposalDepends(proposed[i]!, batch.slice(0, i));
      try {
        assignDependsOn(batch[i]!.id, ids);
      } catch {
        tasks.get(batch[i]!.id)!.dependsOn = [];
      }
    }
    if (dropped) transcript.pushNotice('board_full');
    if (settings.autoRun && userTurn) {
      for (const id of added) {
        const t = tasks.get(id);
        if (t && canLaunch(t)) launchTask(id);
      }
    }
  }

  /** Launch tasks the coordinator asked for via `launch_tasks` (user-initiated turns only). */
  function applyLaunchRequests(ids: readonly string[]): void {
    if (!userTurn) return;
    for (const id of ids) {
      const t = tasks.get(id);
      if (t && canLaunch(t)) launchTask(id);
    }
  }

  async function stop(): Promise<void> {
    startSeq += 1;
    stopPolling();
    disposeOrchestrator();
    transcript.apply({ type: 'agent_settled' });
    endLiveTasks();
    const client = herdr;
    herdr = null;
    if (client) await client.stopServer();
    ownsServer = false;
    setStatus('stopped', null);
    log.info('workbench.stopped');
  }

  function shutdown(): void {
    stopPolling();
    disposeOrchestrator();
    if (herdrBinary && (herdr || ownsServer)) {
      // Detached so the stop completes even as AiOpt exits; it ends every worker.
      try {
        deps.spawnDetached(herdrBinary, ['--session', WORKBENCH_HERDR_SESSION, 'server', 'stop'], cliEnv, deps.homeDir);
      } catch (err) {
        log.warn('workbench.shutdown_failed', { code: errorCode(err) });
      }
    }
    herdr = null;
    ownsServer = false;
  }

  // --- chat -----------------------------------------------------------------------------

  function requireOrchestrator(): PiRpcClient {
    if (status !== 'ready' || !rpc) throwIpcError('PRECONDITION_FAILED', 'workbench is not running');
    return rpc;
  }

  async function chatSend(text: string): Promise<void> {
    const client = requireOrchestrator();
    const message = sanitizeWorkbenchText(text).slice(0, WORKBENCH_LIMITS.chatText);
    if (message === '') throwIpcError('INVALID_PARAMS', 'message is empty');
    try {
      await client.prompt(message, transcript.streaming());
    } catch (err) {
      transcript.pushError(err instanceof Error ? err.message : 'prompt failed');
      changed();
    }
  }

  async function chatAbort(): Promise<void> {
    const client = requireOrchestrator();
    try {
      await client.abort();
    } catch (err) {
      log.warn('workbench.abort_failed', { code: errorCode(err) });
    }
  }

  async function chatReset(): Promise<void> {
    const client = requireOrchestrator();
    if (transcript.streaming()) throwIpcError('PRECONDITION_FAILED', 'wait for the reply to finish');
    try {
      // The old conversation stays in `sessions/`; pi starts a new file.
      await client.newSession();
    } catch (err) {
      log.warn('workbench.reset_failed', { code: errorCode(err) });
      throwIpcError('UPSTREAM_ERROR', 'could not reset the conversation');
    }
    await trackSession(client);
    refreshConversations();
    transcript.clear();
    transcript.pushNotice('session_reset');
    changed();
  }

  async function openConversation(conversationId: string): Promise<void> {
    const client = requireOrchestrator();
    if (transcript.streaming()) throwIpcError('PRECONDITION_FAILED', 'wait for the reply to finish');
    // The path is the one main listed, never one the renderer sent (pi would open any path).
    const conversation = requireConversation(conversationId);
    if (path.basename(conversation.file) === currentSession) return;
    try {
      await client.switchSession(conversation.file);
    } catch (err) {
      log.warn('workbench.open_conversation_failed', { code: errorCode(err) });
      throwIpcError('UPSTREAM_ERROR', 'could not open the conversation');
    }
    await loadTranscript(client);
    await trackSession(client);
    transcript.pushNotice('session_opened');
    changed();
  }

  function deleteConversation(conversationId: string): void {
    const conversation = requireConversation(conversationId);
    if (path.basename(conversation.file) === currentSession) {
      throwIpcError('PRECONDITION_FAILED', 'cannot delete the open conversation');
    }
    try {
      deps.fs.removeFile(conversation.file);
    } catch (err) {
      log.warn('workbench.delete_conversation_failed', { code: errorCode(err) });
      throwIpcError('INTERNAL', 'could not delete the conversation');
    }
    refreshConversations();
    changed();
  }

  // --- folders (public) -----------------------------------------------------------------

  async function addFolder(dir: string): Promise<void> {
    const real = deps.fs.realpath(dir);
    if (!real || !path.isAbsolute(real) || !deps.fs.isDirectory(real)) {
      throwIpcError('NOT_FOUND', 'folder not found');
    }
    if (folders.some((f) => f.path === real)) return;
    if (folders.length >= WORKBENCH_LIMITS.folders) throwIpcError('PRECONDITION_FAILED', 'too many folders');
    const isGitRepo = await deps.isGitRepo(real);
    folders = [...folders, { id: deps.randomId(), name: path.basename(real) || real, path: real, isGitRepo }];
    saveFolders();
    changed();
  }

  function removeFolder(folderId: string): void {
    const folder = folderById(folderId);
    if (!folder) throwIpcError('NOT_FOUND', 'folder not found');
    for (const t of tasks.values()) {
      if (t.folderId === folderId && (isLiveTaskStatus(t.status) || launching.has(t.id))) {
        throwIpcError('PRECONDITION_FAILED', 'a running task uses this folder');
      }
    }
    folders = folders.filter((f) => f.id !== folderId);
    for (const t of tasks.values()) if (t.folderId === folderId && t.status === 'proposed') t.folderId = null;
    saveFolders();
    changed();
  }

  // --- tasks ----------------------------------------------------------------------------

  function requireTask(taskId: string, action: TaskAction): TaskRecord {
    const t = tasks.get(taskId);
    if (!t) throwIpcError('NOT_FOUND', 'task not found');
    if (!taskAllows(action, t.status) || launching.has(taskId)) {
      throwIpcError('PRECONDITION_FAILED', `cannot ${action} a ${t.status} task`);
    }
    return t;
  }

  function cleanTitle(title: string): string {
    return sanitizeWorkbenchText(title).replace(/\s+/g, ' ').slice(0, WORKBENCH_LIMITS.taskTitle);
  }

  function cleanPrompt(prompt: string): string {
    return sanitizeWorkbenchText(prompt).slice(0, WORKBENCH_LIMITS.taskPrompt);
  }

  function insertTask(title: string, prompt: string, origin: TaskOrigin, folderId: string | null, isolated: boolean): string {
    let id = deps.randomId();
    while (tasks.has(id)) id = deps.randomId();
    const now = deps.now();
    tasks.set(id, {
      id,
      title,
      prompt,
      status: 'proposed',
      origin,
      folderId,
      isolated,
      branch: null,
      agentName: null,
      failure: null,
      createdAt: now,
      updatedAt: now,
      workspaceId: null,
      worktreePath: null,
      worktreeRepo: null,
      repoKey: null,
      promptAt: 0,
      outputTail: '',
      dependsOn: [],
    });
    return id;
  }

  function createTask(draft: TaskDraft): string {
    if (tasks.size >= WORKBENCH_LIMITS.tasks) throwIpcError('PRECONDITION_FAILED', 'the board is full');
    const title = cleanTitle(draft.title);
    const prompt = cleanPrompt(draft.prompt);
    if (title === '' || prompt === '') throwIpcError('INVALID_PARAMS', 'title and prompt are required');
    const folderId = draft.folderId ?? null;
    if (folderId !== null && !folderById(folderId)) throwIpcError('NOT_FOUND', 'folder not found');
    const id = insertTask(title, prompt, 'user', folderId, draft.isolated === true);
    if (draft.dependsOn !== undefined && draft.dependsOn !== null) {
      assignDependsOn(id, draft.dependsOn);
    }
    changed();
    return id;
  }

  function updateTask(taskId: string, patch: Partial<TaskDraft>): void {
    const t = requireTask(taskId, 'edit');
    if (patch.title !== undefined) {
      const title = cleanTitle(patch.title);
      if (title === '') throwIpcError('INVALID_PARAMS', 'title is required');
      t.title = title;
    }
    if (patch.prompt !== undefined) {
      const prompt = cleanPrompt(patch.prompt);
      if (prompt === '') throwIpcError('INVALID_PARAMS', 'prompt is required');
      t.prompt = prompt;
    }
    // Where it runs is fixed once a worktree exists for it (relaunch reuses the checkout).
    if (patch.folderId !== undefined || patch.isolated !== undefined) {
      if (t.worktreePath) throwIpcError('PRECONDITION_FAILED', 'the task already has a worktree');
      if (patch.folderId !== undefined) {
        if (patch.folderId !== null && !folderById(patch.folderId)) throwIpcError('NOT_FOUND', 'folder not found');
        t.folderId = patch.folderId;
      }
      if (patch.isolated !== undefined) t.isolated = patch.isolated;
    }
    if (patch.dependsOn !== undefined) {
      if (patch.dependsOn === null) t.dependsOn = [];
      else assignDependsOn(taskId, patch.dependsOn);
    }
    t.updatedAt = deps.now();
    changed();
  }

  function liveCount(): number {
    let n = 0;
    for (const t of tasks.values()) if (isLiveTaskStatus(t.status)) n += 1;
    return n;
  }

  /** Whether a launch would pass its preconditions (for batch and auto runs, which skip, not fail). */
  function canLaunch(t: TaskRecord): boolean {
    const folder = folderById(t.folderId);
    return (
      status === 'ready' &&
      herdr !== null &&
      taskAllows('launch', t.status) &&
      !launching.has(t.id) &&
      folder !== null &&
      (!t.isolated || folder.isGitRepo || t.worktreePath !== null) &&
      liveCount() < WORKBENCH_LIMITS.liveTasks &&
      depsMet(t.dependsOn, taskStatusMap())
    );
  }

  function runAll(): number {
    if (status !== 'ready') throwIpcError('PRECONDITION_FAILED', 'workbench is not running');
    if (!herdr) throwIpcError('PRECONDITION_FAILED', 'herdr is not available');
    let n = 0;
    for (const t of [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (t.status !== 'proposed' || !canLaunch(t)) continue;
      launchTask(t.id);
      n += 1;
    }
    return n;
  }

  function launchTask(taskId: string): void {
    const t = requireTask(taskId, 'launch');
    if (status !== 'ready') throwIpcError('PRECONDITION_FAILED', 'workbench is not running');
    const client = herdr;
    if (!client) throwIpcError('PRECONDITION_FAILED', 'herdr is not available');
    const folder = folderById(t.folderId);
    if (!folder) throwIpcError('PRECONDITION_FAILED', 'pick a folder first');
    if (t.isolated && !folder.isGitRepo && !t.worktreePath) {
      throwIpcError('PRECONDITION_FAILED', 'the folder is not a git repository');
    }
    if (liveCount() >= WORKBENCH_LIMITS.liveTasks) throwIpcError('PRECONDITION_FAILED', 'too many running tasks');
    if (!depsMet(t.dependsOn, taskStatusMap())) throwIpcError('PRECONDITION_FAILED', 'task dependencies are not done');

    t.status = 'starting';
    t.failure = null;
    t.outputTail = '';
    t.updatedAt = deps.now();
    launching.add(taskId);
    changed();
    // Starting a worker takes seconds (pi's TUI comes up in a fresh pane); the board shows
    // `starting` meanwhile and the call returns at once.
    void runLaunch(client, t, folder).finally(() => {
      launching.delete(taskId);
      changed();
    });
  }

  async function runLaunch(client: HerdrClient, t: TaskRecord, folder: FolderRecord): Promise<void> {
    const seq = startSeq;
    try {
      if (!deps.fs.isDirectory(folder.path)) {
        fail(t, 'folder_missing');
        return;
      }
      let workspaceId: string;
      let paneId: string;
      if (t.isolated) {
        if (t.worktreePath && deps.fs.isDirectory(t.worktreePath)) {
          // Relaunch into the checkout a previous run left.
          const ref = await client.workspaceCreate(t.worktreePath, t.title);
          workspaceId = ref.workspaceId;
          paneId = ref.paneId;
        } else {
          const branch = t.branch ?? `wb/${branchSlugFor(t.title, t.id)}`;
          if (!isValidWorkbenchBranch(branch)) throw new HerdrError('invalid', 'bad branch');
          t.branch = branch;
          const ref = await client.worktreeCreate(folder.path, branch);
          workspaceId = ref.workspaceId;
          paneId = ref.paneId;
          t.worktreePath = ref.path;
          t.worktreeRepo = folder.path;
          t.repoKey = ref.repoKey;
        }
      } else {
        const ref = await client.workspaceCreate(folder.path, t.title);
        workspaceId = ref.workspaceId;
        paneId = ref.paneId;
      }
      t.workspaceId = workspaceId;
      const agentName = `wb-${t.id}`;
      t.agentName = agentName;
      await client.agentStart(agentName, paneId, WORKER_PI_ARGS);
      await client.agentPrompt(agentName, t.prompt);
      if (seq !== startSeq || t.status !== 'starting') return; // Stopped meanwhile.
      t.status = 'working';
      t.promptAt = deps.now();
      t.updatedAt = t.promptAt;
      log.info('workbench.task_launched', { isolated: t.isolated });
    } catch (err) {
      log.warn('workbench.task_launch_failed', { code: errorCode(err) });
      if (t.workspaceId) await closeWorkspace(client, t);
      if (t.status === 'starting') fail(t, 'herdr_error');
    }
    if (t.status === 'failed') queueNotify([t.id]);
  }

  function fail(t: TaskRecord, failure: TaskFailure): void {
    t.status = 'failed';
    t.failure = failure;
    t.updatedAt = deps.now();
  }

  /** Close the worker's workspace (ending pi), plus herdr's repo workspace once unused. */
  async function closeWorkspace(client: HerdrClient, t: TaskRecord): Promise<void> {
    const workspaceId = t.workspaceId;
    t.workspaceId = null;
    if (!workspaceId) return;
    try {
      await client.workspaceClose(workspaceId);
    } catch (err) {
      if (!(err instanceof HerdrError && err.code === 'workspace_not_found')) {
        log.warn('workbench.workspace_close_failed', { code: errorCode(err) });
      }
    }
    // `worktree create` also opens the source repo as a workspace when it is not open yet.
    if (!t.repoKey) return;
    const stillUsed = [...tasks.values()].some((o) => o !== t && o.workspaceId !== null && o.repoKey === t.repoKey);
    if (stillUsed) return;
    try {
      const rows = await client.workspaceList();
      const busy = new Set([...tasks.values()].map((o) => o.workspaceId).filter((id): id is string => id !== null));
      for (const row of rows) {
        if (row.repoKey === t.repoKey && !row.isLinkedWorktree && !busy.has(row.workspaceId)) {
          await client.workspaceClose(row.workspaceId);
        }
      }
    } catch (err) {
      log.warn('workbench.repo_workspace_close_failed', { code: errorCode(err) });
    }
  }

  function requireHerdr(): HerdrClient {
    if (!herdr) throwIpcError('PRECONDITION_FAILED', 'herdr is not available');
    return herdr;
  }

  async function messageTask(taskId: string, text: string): Promise<void> {
    const t = requireTask(taskId, 'message');
    const client = requireHerdr();
    const message = sanitizeWorkbenchText(text).slice(0, WORKBENCH_LIMITS.taskPrompt);
    if (message === '' || !t.agentName) throwIpcError('INVALID_PARAMS', 'message is empty');
    try {
      await client.agentPrompt(t.agentName, message);
    } catch (err) {
      log.warn('workbench.task_message_failed', { code: errorCode(err) });
      throwIpcError('UPSTREAM_ERROR', 'could not reach the worker');
    }
    t.status = 'working';
    t.promptAt = deps.now();
    t.updatedAt = t.promptAt;
    changed();
  }

  async function endTask(taskId: string, action: 'complete' | 'stop'): Promise<void> {
    const t = requireTask(taskId, action);
    t.status = action === 'complete' ? 'done' : 'stopped';
    t.updatedAt = deps.now();
    changed();
    if (herdr) await closeWorkspace(herdr, t);
    else t.workspaceId = null;
    changed();
    if (action === 'complete') maybeLaunchDependents(taskId);
  }

  async function removeTask(taskId: string): Promise<void> {
    const t = requireTask(taskId, 'remove');
    if (t.worktreePath && t.worktreeRepo && deps.fs.isDirectory(t.worktreePath)) {
      // Remove the checkout, never forced: uncommitted changes keep it (and the task) in
      // place. The branch is left alone — its commits are the task's result.
      if (!gitBinary) throwIpcError('PRECONDITION_FAILED', 'git is not available');
      const out = await deps.exec(gitBinary, ['-C', t.worktreeRepo, 'worktree', 'remove', '--', t.worktreePath], 20_000, cliEnv);
      if (out.code !== 0) {
        log.warn('workbench.worktree_remove_failed', { code: out.code ?? undefined });
        throwIpcError('PRECONDITION_FAILED', 'the worktree has uncommitted changes');
      }
    }
    tasks.delete(taskId);
    for (const other of tasks.values()) {
      if (other.dependsOn.includes(taskId)) {
        other.dependsOn = other.dependsOn.filter((id) => id !== taskId);
        other.updatedAt = deps.now();
      }
    }
    changed();
  }

  async function readTail(client: HerdrClient, agentName: string): Promise<string> {
    try {
      const text = await client.agentRead(agentName, WORKBENCH_LIMITS.outputLines);
      return sanitizeWorkbenchText(text).trim().slice(-WORKBENCH_LIMITS.taskOutputTail);
    } catch (err) {
      log.debug('workbench.task_output_failed', { code: errorCode(err) });
      return '';
    }
  }

  // --- coordinator updates --------------------------------------------------------------

  function queueNotify(ids: readonly string[]): void {
    if (!settings.notifyCoordinator) return;
    for (const id of ids) pendingNotify.add(id);
    if (notifyScheduled) return;
    notifyScheduled = true;
    void deps.sleep(NOTIFY_DEBOUNCE_MS).then(flushNotify);
  }

  async function flushNotify(): Promise<void> {
    notifyScheduled = false;
    // Ids are main-minted `[a-z0-9]` (the extension re-checks); the board file is current.
    const ids = [...pendingNotify].filter((id) => tasks.has(id) && isValidWorkbenchId(id));
    pendingNotify.clear();
    const client = rpc;
    if (ids.length === 0 || !client || status !== 'ready' || !settings.notifyCoordinator) return;
    saveTasks();
    try {
      await client.command(`/${TASK_UPDATE_COMMAND} ${ids.join(' ')}`);
    } catch (err) {
      log.warn('workbench.notify_failed', { code: errorCode(err) });
    }
  }

  async function taskOutput(taskId: string): Promise<string> {
    const t = tasks.get(taskId);
    if (!t) throwIpcError('NOT_FOUND', 'task not found');
    if (!t.agentName || !isLiveTaskStatus(t.status) || launching.has(taskId)) return '';
    const client = requireHerdr();
    try {
      const text = await client.agentRead(t.agentName, WORKBENCH_LIMITS.outputLines);
      // Terminal text is shown as plain text: strip control characters (escape sequences).
      return sanitizeWorkbenchText(text).slice(-WORKBENCH_LIMITS.itemText);
    } catch (err) {
      log.debug('workbench.task_output_failed', { code: errorCode(err) });
      return '';
    }
  }

  // --- polling --------------------------------------------------------------------------

  async function poll(): Promise<void> {
    const client = herdr;
    if (polling || !client || status !== 'ready') return;
    const watched = [...tasks.values()].filter((t) => isLiveTaskStatus(t.status) && !launching.has(t.id) && t.agentName);
    if (watched.length === 0) return;
    polling = true;
    try {
      const rows = await client.agentList();
      const byName = new Map(rows.map((r) => [r.name, r]));
      const now = deps.now();
      let dirty = false;
      const notable: TaskRecord[] = [];
      for (const t of watched) {
        if (!isLiveTaskStatus(t.status) || launching.has(t.id)) continue;
        const row = byName.get(t.agentName!);
        const next: TaskStatus = row ? nextTaskStatus(t.status, row.status, now - t.promptAt) : 'failed';
        if (next === t.status) continue;
        t.status = next;
        if (next === 'failed') {
          // The worker went away (pi exited, or its pane was closed from herdr).
          // Its workspace may linger (pi exited, the pane's shell is still open): close it.
          t.failure = 'agent_lost';
          void closeWorkspace(client, t);
        }
        t.updatedAt = now;
        dirty = true;
        if (NOTIFY_STATUSES.includes(next)) notable.push(t);
      }
      if (dirty) changed();
      if (notable.length > 0) {
        for (const t of notable) {
          // What the worker left on screen, for the coordinator's summary (not for a lost one).
          if (t.status !== 'failed' && t.agentName) t.outputTail = await readTail(client, t.agentName);
        }
        changed();
        queueNotify(notable.map((t) => t.id));
      }
    } catch (err) {
      log.debug('workbench.poll_failed', { code: errorCode(err) });
    } finally {
      polling = false;
    }
  }

  return {
    getSnapshot,
    start,
    stop,
    shutdown,
    chatSend,
    chatAbort,
    chatReset,
    addFolder,
    removeFolder,
    createTask,
    updateTask,
    launchTask,
    messageTask,
    completeTask: (id) => endTask(id, 'complete'),
    stopTask: (id) => endTask(id, 'stop'),
    removeTask,
    taskOutput,
    runAll,
    openConversation,
    deleteConversation,
    updateSettings,
  };
}
