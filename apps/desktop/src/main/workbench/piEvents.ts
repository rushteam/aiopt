// Fold pi RPC events into the orchestrator chat transcript.
//
// pi streams one run as agent_start → (message_start / message_update* / message_end,
// tool_execution_start / tool_execution_end)* → agent_end → agent_settled (docs/rpc.md
// "Events"). This reducer turns that stream into the flat ChatItem list the renderer draws, and
// pulls the structured tasks out of every successful `propose_tasks` tool result — the tool's
// `details` payload is the channel the orchestrator uses to hand work to AiOpt.
//
// It also rebuilds a transcript from a saved session (`load`, fed pi's `get_messages`) when the
// user reopens a past conversation. A reload never re-proposes: those tasks were handled then.
//
// Pure — no I/O. Everything read from an event is treated as untrusted model output: typed
// defensively, sanitized, and capped, so a malformed or hostile record can't blow up the
// transcript or smuggle a control sequence into a worker's terminal.

import {
  isTaskStatus,
  isValidWorkbenchId,
  sanitizeWorkbenchText,
  WORKBENCH_LIMITS,
  type ChatItem,
  type TaskStatus,
  type WorkbenchNotice,
} from '../../shared/workbench';

/** The orchestrator's task-proposal tool (see orchestratorExtension.ts). */
export const PROPOSE_TASKS_TOOL = 'propose_tasks';

/** Ask main to launch existing board tasks (see orchestratorExtension.ts). */
export const LAUNCH_TASKS_TOOL = 'launch_tasks';

export interface TranscriptEffects {
  proposed: ProposedTask[];
  launchTaskIds: string[];
}

const NO_EFFECTS: TranscriptEffects = { proposed: [], launchTaskIds: [] };

/** The custom message the extension injects when AiOpt reports task changes. */
export const TASK_UPDATE_MESSAGE = 'aiopt-task-update';

export interface ProposedTask {
  title: string;
  prompt: string;
  /** The folder the orchestrator suggests, by the name `list_folders` gave it. A hint only. */
  folder: string | null;
  /** Titles of tasks earlier in the same `propose_tasks` call. */
  dependsOnTitles: string[];
  /** Ids of tasks already on the board (`list_tasks`). */
  dependsOnIds: string[];
}

export interface Transcript {
  /** Apply one pi event; returns board mutations main should apply (usually none). */
  apply(event: Record<string, unknown>): TranscriptEffects;
  /** Record a local error line (e.g. a failed prompt) in the transcript. */
  pushError(message: string): void;
  pushNotice(code: WorkbenchNotice): void;
  /** Replace the transcript with a saved session's messages (pi `get_messages`). */
  load(messages: readonly unknown[]): void;
  items(): ChatItem[];
  streaming(): boolean;
  clear(): void;
}

function cap(text: string, max: number = WORKBENCH_LIMITS.itemText): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Join the `text` blocks of a content value (a string, or an array of typed blocks). */
function contentText(content: unknown, type: 'text' | 'thinking' = 'text'): string {
  if (typeof content === 'string') return type === 'text' ? content : '';
  if (!Array.isArray(content)) return '';
  const field = type === 'text' ? 'text' : 'thinking';
  return content
    .map((block) => {
      const b = asRecord(block);
      return b && b.type === type && typeof b[field] === 'string' ? (b[field] as string) : '';
    })
    .filter((s) => s !== '')
    .join('\n');
}

function stringifyArgs(args: unknown): string {
  if (args === undefined) return '';
  try {
    return cap(JSON.stringify(args, null, 2) ?? '');
  } catch {
    return '';
  }
}

/** Validate a `propose_tasks` details payload into at most `tasksPerProposal` clean tasks. */
export function extractProposedTasks(details: unknown): ProposedTask[] {
  const tasks = asRecord(details)?.tasks;
  if (!Array.isArray(tasks)) return [];
  const out: ProposedTask[] = [];
  for (const raw of tasks) {
    if (out.length >= WORKBENCH_LIMITS.tasksPerProposal) break;
    const task = asRecord(raw);
    if (!task || typeof task.title !== 'string' || typeof task.prompt !== 'string') continue;
    const title = sanitizeWorkbenchText(task.title).replace(/\s+/g, ' ').slice(0, WORKBENCH_LIMITS.taskTitle);
    const prompt = sanitizeWorkbenchText(task.prompt).slice(0, WORKBENCH_LIMITS.taskPrompt);
    if (title === '' || prompt === '') continue;
    const folder =
      typeof task.folder === 'string' ? sanitizeWorkbenchText(task.folder).slice(0, 200) || null : null;
    const dependsOnTitles: string[] = [];
    const titleRaw = task.depends_on_titles;
    if (Array.isArray(titleRaw)) {
      for (const rawTitle of titleRaw) {
        if (dependsOnTitles.length >= WORKBENCH_LIMITS.tasksPerProposal) break;
        if (typeof rawTitle !== 'string') continue;
        const depTitle = sanitizeWorkbenchText(rawTitle).replace(/\s+/g, ' ').slice(0, WORKBENCH_LIMITS.taskTitle);
        if (depTitle !== '' && !dependsOnTitles.includes(depTitle)) dependsOnTitles.push(depTitle);
      }
    }
    const dependsOnIds: string[] = [];
    const idRaw = task.depends_on_ids;
    if (Array.isArray(idRaw)) {
      for (const rawId of idRaw) {
        if (dependsOnIds.length >= WORKBENCH_LIMITS.tasksPerProposal) break;
        if (typeof rawId === 'string' && isValidWorkbenchId(rawId) && !dependsOnIds.includes(rawId)) {
          dependsOnIds.push(rawId);
        }
      }
    }
    out.push({ title, prompt, folder, dependsOnTitles, dependsOnIds });
  }
  return out;
}

/** Validate a `launch_tasks` details payload into opaque task ids main minted. */
export function extractLaunchTaskIds(details: unknown): string[] {
  const raw = asRecord(details)?.task_ids;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const id of raw) {
    if (out.length >= WORKBENCH_LIMITS.tasksPerProposal) break;
    if (isValidWorkbenchId(id)) out.push(id);
  }
  return out;
}

/** The task list of a task-update message's details: `{ tasks: [{ title, status }] }`. */
function taskUpdateTasks(details: unknown): { title: string; status: TaskStatus }[] {
  const tasks = asRecord(details)?.tasks;
  if (!Array.isArray(tasks)) return [];
  const out: { title: string; status: TaskStatus }[] = [];
  for (const raw of tasks) {
    if (out.length >= WORKBENCH_LIMITS.tasksPerProposal) break;
    const task = asRecord(raw);
    if (!task || typeof task.title !== 'string' || !isTaskStatus(task.status)) continue;
    const title = sanitizeWorkbenchText(task.title).replace(/\s+/g, ' ').slice(0, WORKBENCH_LIMITS.taskTitle);
    if (title !== '') out.push({ title, status: task.status });
  }
  return out;
}

export function createTranscript(): Transcript {
  let items: ChatItem[] = [];
  let isStreaming = false;
  let seq = 0;
  const nextId = () => `c${(seq += 1)}`;

  function push(item: ChatItem): void {
    items.push(item);
    if (items.length > WORKBENCH_LIMITS.chatItems) items = items.slice(-WORKBENCH_LIMITS.chatItems);
  }

  /** The assistant item currently being streamed, if any. */
  function openAssistant(): Extract<ChatItem, { kind: 'assistant' }> | null {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]!;
      if (item.kind === 'assistant') return item.streaming ? item : null;
    }
    return null;
  }

  function toolItem(id: string): Extract<ChatItem, { kind: 'tool' }> | null {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]!;
      if (item.kind === 'tool' && item.id === id) return item;
    }
    return null;
  }

  function pushUser(message: Record<string, unknown>): void {
    const text = cap(contentText(message.content));
    if (text !== '') push({ kind: 'user', id: nextId(), text });
  }

  function pushCustom(message: Record<string, unknown>): void {
    if (message.customType !== TASK_UPDATE_MESSAGE) return;
    const tasks = taskUpdateTasks(message.details);
    if (tasks.length > 0) push({ kind: 'taskUpdate', id: nextId(), tasks });
  }

  function pushErrorOf(message: Record<string, unknown>): void {
    if (message.stopReason !== 'error') return;
    const reason = typeof message.errorMessage === 'string' ? message.errorMessage : '';
    push({ kind: 'error', id: nextId(), message: cap(reason, 500) });
  }

  /** One saved message into the transcript (see `load`). */
  function loadMessage(raw: unknown): void {
    const message = asRecord(raw);
    if (!message) return;
    switch (message.role) {
      case 'user':
        pushUser(message);
        return;
      case 'custom':
        pushCustom(message);
        return;
      case 'assistant': {
        const text = cap(contentText(message.content));
        const thinking = cap(contentText(message.content, 'thinking'));
        if (text !== '' || thinking !== '') {
          push({ kind: 'assistant', id: nextId(), text, thinking, streaming: false });
        }
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            const b = asRecord(block);
            if (!b || b.type !== 'toolCall' || typeof b.id !== 'string' || typeof b.name !== 'string') continue;
            push({
              kind: 'tool',
              id: b.id,
              name: cap(b.name, 64),
              args: stringifyArgs(b.arguments),
              result: '',
              isError: false,
              done: true,
            });
          }
        }
        pushErrorOf(message);
        return;
      }
      case 'toolResult': {
        if (typeof message.toolCallId !== 'string') return;
        const target = toolItem(message.toolCallId);
        if (target) {
          target.result = cap(contentText(message.content));
          target.isError = message.isError === true;
        }
        return;
      }
      default:
        return;
    }
  }

  return {
    apply(event) {
      switch (event.type) {
        case 'agent_start':
          isStreaming = true;
          return NO_EFFECTS;
        case 'agent_end':
          if (event.willRetry !== true) isStreaming = false;
          return NO_EFFECTS;
        case 'agent_settled':
          isStreaming = false;
          return NO_EFFECTS;
        case 'message_start': {
          const message = asRecord(event.message);
          if (message?.role === 'user') {
            pushUser(message);
          } else if (message?.role === 'custom') {
            pushCustom(message);
          } else if (message?.role === 'assistant') {
            push({ kind: 'assistant', id: nextId(), text: '', thinking: '', streaming: true });
          }
          return NO_EFFECTS;
        }
        case 'message_update': {
          const delta = asRecord(event.assistantMessageEvent);
          const target = openAssistant();
          if (!delta || !target || typeof delta.delta !== 'string') return NO_EFFECTS;
          if (delta.type === 'text_delta') target.text = cap(target.text + delta.delta);
          else if (delta.type === 'thinking_delta') target.thinking = cap(target.thinking + delta.delta);
          return NO_EFFECTS;
        }
        case 'message_end': {
          const message = asRecord(event.message);
          if (message?.role !== 'assistant') return NO_EFFECTS;
          // message_end is authoritative (docs/rpc.md): replace the streamed deltas with it.
          const target = openAssistant();
          const text = cap(contentText(message.content));
          const thinking = cap(contentText(message.content, 'thinking'));
          if (target) {
            target.text = text;
            target.thinking = thinking;
            target.streaming = false;
            // A tool-only turn leaves an empty bubble; drop it rather than render nothing.
            if (text === '' && thinking === '') items = items.filter((i) => i !== target);
          }
          pushErrorOf(message);
          return NO_EFFECTS;
        }
        case 'tool_execution_start': {
          if (typeof event.toolCallId !== 'string' || typeof event.toolName !== 'string') return NO_EFFECTS;
          push({
            kind: 'tool',
            id: event.toolCallId,
            name: cap(event.toolName, 64),
            args: stringifyArgs(event.args),
            result: '',
            isError: false,
            done: false,
          });
          return NO_EFFECTS;
        }
        case 'tool_execution_end': {
          if (typeof event.toolCallId !== 'string') return NO_EFFECTS;
          const result = asRecord(event.result);
          const isError = event.isError === true;
          const target = toolItem(event.toolCallId);
          if (target) {
            target.result = cap(contentText(result?.content));
            target.isError = isError;
            target.done = true;
          }
          if (isError) return NO_EFFECTS;
          if (event.toolName === PROPOSE_TASKS_TOOL) {
            return { proposed: extractProposedTasks(result?.details), launchTaskIds: [] };
          }
          if (event.toolName === LAUNCH_TASKS_TOOL) {
            return { proposed: [], launchTaskIds: extractLaunchTaskIds(result?.details) };
          }
          return NO_EFFECTS;
        }
        case 'extension_error': {
          const message = typeof event.error === 'string' ? event.error : '';
          push({ kind: 'error', id: nextId(), message: cap(message, 500) });
          return NO_EFFECTS;
        }
        default:
          return NO_EFFECTS;
      }
    },
    pushError(message) {
      push({ kind: 'error', id: nextId(), message: cap(message, 500) });
    },
    pushNotice(code) {
      push({ kind: 'notice', id: nextId(), code });
    },
    load(messages) {
      items = [];
      isStreaming = false;
      for (const message of messages) loadMessage(message);
    },
    // A structural copy, so a caller holding the array can't mutate the live transcript.
    items: () => items.map((item) => ({ ...item })),
    streaming: () => isStreaming,
    clear() {
      items = [];
      isStreaming = false;
    },
  };
}
