// Workbench — pure types + limits + validation, shared by main and renderer.
//
// The workbench is a multi-agent work assistant built from two external tools the user has
// installed: `pi` (a coding agent CLI) and `herdr` (a terminal multiplexer that hosts agents in
// panes). One pi process runs headless in RPC mode as the ORCHESTRATOR you chat with; it breaks
// work down by calling its `propose_tasks` tool. Each proposed task waits for the user to
// approve it and pick a folder, then runs as its own pi WORKER inside a herdr pane, where the
// user can also watch or take it over from a terminal (`herdr --session aiopt`).
//
// SECURITY (docs/dev-rules/electron-security-and-process-boundaries.md): the renderer never
// supplies a command, a binary, an argv entry, or a path. It names a folder by an opaque id that
// main minted when the user picked it in a main-side dialog, and a task by its id. Free text
// (chat messages, task prompts) is length-capped here and re-validated in main before it is
// handed to a child process. Model credentials never appear in any of these shapes.
//
// No I/O, no Electron here.

/** The herdr session AiOpt owns. Never the user's `default` session. */
export const WORKBENCH_HERDR_SESSION = 'aiopt';

/** Caps shared by the renderer (input maxLength) and main (re-validation). */
export const WORKBENCH_LIMITS = {
  chatText: 8000,
  taskTitle: 120,
  taskPrompt: 8000,
  /** How many tasks one `propose_tasks` call (or the board) may hold. */
  tasksPerProposal: 10,
  tasks: 50,
  /** Workers running at once (each is a pi process with its own model traffic). */
  liveTasks: 6,
  folders: 20,
  /** Transcript items kept in memory; the oldest drop first. */
  chatItems: 200,
  /** Characters kept per transcript text (assistant text, tool args/result). */
  itemText: 32_000,
  /** Lines of a worker's terminal shown in the task panel. */
  outputLines: 80,
  /** Past conversations listed (newest first); older files stay on disk, unlisted. */
  conversations: 50,
  conversationTitle: 80,
  /** Characters of a worker's terminal kept with a task for the coordinator. */
  taskOutputTail: 2000,
} as const;

/** Whether the orchestrator + herdr session are running. */
export type WorkbenchStatus = 'stopped' | 'starting' | 'ready' | 'error';

/**
 * Why the workbench can't run (or stopped). A closed set so the renderer maps each one to a
 * localized hint; free-text detail stays in the main log.
 */
export type WorkbenchIssue =
  | 'unsupported_platform'
  | 'pi_missing'
  | 'herdr_missing'
  | 'no_binding'
  | 'start_failed'
  | 'orchestrator_exited';

/** One transcript entry of the orchestrator chat. */
export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; thinking: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      /** Tool arguments as (capped) JSON text. */
      args: string;
      result: string;
      isError: boolean;
      done: boolean;
    }
  | { kind: 'error'; id: string; message: string }
  /** A coded, localized line AiOpt adds itself (e.g. proposals dropped: the board is full). */
  | { kind: 'notice'; id: string; code: WorkbenchNotice }
  /** AiOpt told the coordinator that tasks changed state (it replies with a summary). */
  | { kind: 'taskUpdate'; id: string; tasks: { title: string; status: TaskStatus }[] };

export type WorkbenchNotice = 'board_full' | 'session_reset' | 'session_opened';

/**
 * A task's lifecycle.
 *
 * proposed ─launch→ starting → working ⇄ blocked
 *                                  └→ review (the worker finished its turn) ─message→ working
 * review/working/blocked ─complete→ done;  any live state ─stop→ stopped;  start error → failed.
 */
export type TaskStatus =
  | 'proposed'
  | 'starting'
  | 'working'
  | 'blocked'
  | 'review'
  | 'done'
  | 'stopped'
  | 'failed';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'proposed',
  'starting',
  'working',
  'blocked',
  'review',
  'done',
  'stopped',
  'failed',
];

/** Statuses in which a worker process is (or should be) alive in herdr. */
export const LIVE_TASK_STATUSES: readonly TaskStatus[] = ['starting', 'working', 'blocked', 'review'];

export function isLiveTaskStatus(status: TaskStatus): boolean {
  return (LIVE_TASK_STATUSES as readonly string[]).includes(status);
}

/** Which user actions a task accepts in a given status. Main enforces this; the renderer mirrors it. */
export const TASK_ACTIONS = {
  edit: ['proposed', 'stopped', 'failed'],
  launch: ['proposed', 'stopped', 'failed'],
  message: ['working', 'blocked', 'review'],
  complete: ['working', 'blocked', 'review'],
  stop: ['starting', 'working', 'blocked', 'review'],
  remove: ['proposed', 'done', 'stopped', 'failed'],
} as const satisfies Record<string, readonly TaskStatus[]>;

export type TaskAction = keyof typeof TASK_ACTIONS;

export function taskAllows(action: TaskAction, status: TaskStatus): boolean {
  return (TASK_ACTIONS[action] as readonly TaskStatus[]).includes(status);
}

/** Where a task came from. */
export type TaskOrigin = 'orchestrator' | 'user';

/** A task as the renderer sees it. */
export interface TaskView {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  origin: TaskOrigin;
  /**
   * The granted folder the worker runs (or will run) in. While proposed it is the
   * orchestrator's suggestion or the user's pick; null when neither has chosen one.
   */
  folderId: string | null;
  /** Whether the worker runs in its own git worktree (a new branch) rather than the folder. */
  isolated: boolean;
  /** The worktree branch, when isolated. Display only. */
  branch: string | null;
  /** Home-shortened checkout path of the worktree, when isolated. Display only. */
  worktreeDisplay: string | null;
  /** The herdr agent name (`herdr agent attach <name>`); null until launched. */
  agentName: string | null;
  /** A coded failure reason for `failed` (see {@link TaskFailure}). */
  failure: TaskFailure | null;
  /** Task ids that must reach `done` before this one may launch. */
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
}

export type TaskFailure = 'herdr_error' | 'folder_missing' | 'agent_lost';

/** A folder the user granted via the main-side picker. Display fields only. */
export interface FolderView {
  id: string;
  /** Last path segment, for compact labels. */
  name: string;
  /** Home-shortened path (`~/code/app`). Display only; never fed back to main. */
  displayPath: string;
  /** Whether the folder is a git checkout (so a task can be isolated in a worktree). */
  isGitRepo: boolean;
}

/** The model the workbench agents use — derived from pi's binding in Providers. */
export interface WorkbenchModel {
  providerName: string;
  modelId: string;
  /** Whether the traffic goes through AiOpt's loopback proxy (counted in Usage). */
  proxied: boolean;
}

/**
 * A saved conversation with the coordinator. `id` is opaque (the session's uuid); main maps it
 * back to a file it listed itself, so the renderer never names a path.
 */
export interface ConversationView {
  id: string;
  /** The first thing the user asked, trimmed; '' when there is nothing to show. */
  title: string;
  updatedAt: number;
  /** The conversation the coordinator is in now. */
  current: boolean;
}

/** Where the resolved herdr binary came from (display only). */
export type HerdrInstallSource = 'managed' | 'path' | null;

/** herdr CLI detection — updated on open, after install, and when workbench starts. */
export interface HerdrProbeView {
  installed: boolean;
  source: HerdrInstallSource;
  /** Home-relative when under the user's home; otherwise a short label (e.g. managed copy). */
  displayPath: string | null;
  version: string | null;
  installing: boolean;
  /** When set, task commands run on the remote host via `ssh target herdr …`. */
  remote: boolean;
}

/** The user's workbench preferences (only changed keys are persisted; see manager). */
export interface WorkbenchSettings {
  /** Run the coordinator's proposals at once when they have a folder (user-asked turns only). */
  autoRun: boolean;
  /** Tell the coordinator when a task needs review, needs input, or fails. */
  notifyCoordinator: boolean;
  /** When a task reaches `done`, launch proposed dependents that are otherwise ready (user turns only). */
  autoLaunchDependents: boolean;
  /**
   * Optional SSH destination (`user@host`) for herdr. Empty means local. This is not herdr's
   * `--remote` TUI attach flag — Workbench drives the socket API over SSH instead.
   */
  herdrSshTarget: string | null;
}

export const DEFAULT_WORKBENCH_SETTINGS: Readonly<WorkbenchSettings> = {
  autoRun: false,
  notifyCoordinator: true,
  autoLaunchDependents: false,
  herdrSshTarget: null,
};

const HERDR_SSH_TARGET_RE = /^[a-zA-Z0-9._@:\-]{1,200}$/;

export function isValidHerdrSshTarget(value: string): boolean {
  return HERDR_SSH_TARGET_RE.test(value);
}

/** Whether every dependency on the board is `done`. */
export function taskDependenciesMet(task: Pick<TaskView, 'dependsOn'>, tasks: readonly TaskView[]): boolean {
  if (task.dependsOn.length === 0) return true;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const id of task.dependsOn) {
    const dep = byId.get(id);
    if (!dep || dep.status !== 'done') return false;
  }
  return true;
}

/** Dependencies that still block launch (missing or not done). */
export function pendingDependencies(task: Pick<TaskView, 'dependsOn'>, tasks: readonly TaskView[]): TaskView[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: TaskView[] = [];
  for (const id of task.dependsOn) {
    const dep = byId.get(id);
    if (dep && dep.status !== 'done') out.push(dep);
  }
  return out;
}

export interface WorkbenchSnapshot {
  status: WorkbenchStatus;
  issue: WorkbenchIssue | null;
  model: WorkbenchModel | null;
  /** Whether the orchestrator is currently producing a reply. */
  streaming: boolean;
  chat: ChatItem[];
  tasks: TaskView[];
  folders: FolderView[];
  /** The herdr session name, for the "attach from a terminal" hint. */
  herdrSession: string;
  /** Whether the herdr binary was found (the tasks side needs it; chat does not). */
  herdrAvailable: boolean;
  /** CLI probe (local managed copy first, then PATH). Independent of `status`. */
  herdrProbe: HerdrProbeView;
  /** Saved conversations, newest first. The current one is absent until it has a message. */
  conversations: ConversationView[];
  settings: WorkbenchSettings;
}

/** The tail of a worker's terminal. */
export interface TaskOutput {
  text: string;
}

/** Opaque ids minted by main for tasks and folders. */
const ID_RE = /^[a-z0-9]{1,32}$/;

export function isValidWorkbenchId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/** A conversation id: a lowercase uuid. */
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID_RE.test(value);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * herdr agent names must match `[a-z][a-z0-9_-]{0,31}`. Main derives them from the task id, so
 * this is a belt-and-braces guard before one becomes an argv entry.
 */
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidAgentName(value: unknown): value is string {
  return typeof value === 'string' && AGENT_NAME_RE.test(value);
}

/** A git branch segment we create for an isolated task (`wb/<slug>`). */
const BRANCH_RE = /^wb\/[a-z0-9][a-z0-9-]{0,40}$/;

export function isValidWorkbenchBranch(value: unknown): value is string {
  return typeof value === 'string' && BRANCH_RE.test(value);
}

/**
 * Normalize user/model text for a child process: drop C0/C1 control characters other than tab
 * and newline (an ESC sequence typed into a terminal pane is a command to the terminal, not
 * text), normalize CRLF, and trim. Returns '' when nothing printable is left.
 */
export function sanitizeWorkbenchText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .trim();
}

/** A branch-safe slug from a task title (ASCII only; falls back to the task id). */
export function branchSlugFor(title: string, taskId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return slug ? `${slug}-${taskId.slice(0, 6)}` : taskId.slice(0, 12);
}
