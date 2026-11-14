// The write gate: how a worker's `write` / `edit` outside the workbench folders reaches the user.
//
// Workers are full coding agents (workbenchManager.ts). Their pi extension
// (workerExtension.ts) lets `write` and `edit` through only inside the task's working dir and
// the folders the user granted in the explorer. Any other target is held: the extension drops
// a request file into `<dataDir>/write-gate/` and waits; main lists it in the snapshot, the
// workbench shows an Allow / Deny card, and main writes the user's answer next to the request.
// No answer (timeout, AiOpt not running, the task stopped) means no.
//
//   <uuid>.req.json   worker → main   { v: 1, tool: 'write' | 'edit', path, cwd, pane? }
//   <uuid>.res.json   main → worker   { allow: boolean }
//
// The extension removes both files when it is done; main sweeps what a dead worker left.
//
// This is a guardrail against a model's mistakes, NOT a security boundary: a worker also has
// `bash`, which can write anywhere and could even write an answer file itself. So the request is
// treated as untrusted display data (bounded, control and bidi characters stripped), it can only
// ever cost the user a card, and a request that does not name exactly one live task — by its
// working dir, and by its herdr pane when several tasks share that dir — is refused without
// asking. The renderer answers by request id only (workbenchIpc.ts); main
// accepts an answer once, and only for a request that is still waiting.
//
// Electron-free: services.ts raises the background notification.

import path from 'node:path';
import { resolveMenuLocale, type MenuLocale } from '../menu/menuLabels';
import { sanitizeWorkbenchText, type PendingWriteView } from '../../shared/workbench';
import type { Logger } from '../logger';
import type { WorkbenchFs } from './workbenchManager';

/** The env var naming the gate directory (set on the herdr server, so every worker sees it). */
export const WRITE_GATE_DIR_ENV = 'AIOPT_WB_WRITE_GATE_DIR';

/** How long a worker waits for an answer before it treats the write as refused. */
export const WRITE_GATE_TIMEOUT_MS = 10 * 60_000;

/** The tools the gate holds. */
export const WRITE_GATE_TOOLS = ['write', 'edit'] as const;
export type WriteGateTool = (typeof WRITE_GATE_TOOLS)[number];

const REQUEST_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.req\.json$/;
const GATE_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(req|res)\.json(\.tmp)?$|\.tmp$/;
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_PATH_CHARS = 4096;
/** Characters shown per path. */
const MAX_SHOWN_PATH = 1000;
/** Requests waiting at once; more are refused (a runaway worker cannot flood the view). */
const MAX_WAITING = 20;

export interface WriteGateRequest {
  id: string;
  tool: WriteGateTool;
  /** Absolute target the worker resolved (display only). */
  path: string;
  /** The worker's working dir: matched against live tasks, never used as a path to act on. */
  cwd: string;
  /** The worker's herdr pane (`HERDR_PANE_ID`), telling apart tasks that share a dir. */
  pane: string | null;
}

/** herdr's pane ids (`w3:p1`); see herdrCli.ts. */
const PANE_RE = /^w[0-9A-Za-z]{1,8}:p[0-9A-Za-z]{1,8}$/;

/** Strip what could disguise a path on screen: control, bidi and zero-width characters. */
function displayText(value: string, max: number): string {
  const clean = sanitizeWorkbenchText(value)
    .replace(/[\n\t]/g, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** A request file's contents, or null when it is not a well-formed request. */
export function parseWriteGateRequest(fileName: string, text: string): WriteGateRequest | null {
  const id = REQUEST_RE.exec(fileName)?.[1];
  if (!id || text.length > MAX_REQUEST_BYTES) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const { v, tool, path: target, cwd, pane } = doc as Record<string, unknown>;
  if (v !== 1) return null;
  if (typeof tool !== 'string' || !(WRITE_GATE_TOOLS as readonly string[]).includes(tool)) return null;
  if (typeof target !== 'string' || target === '' || target.length > MAX_PATH_CHARS) return null;
  if (typeof cwd !== 'string' || cwd === '' || cwd.length > MAX_PATH_CHARS) return null;
  if (pane !== undefined && (typeof pane !== 'string' || !PANE_RE.test(pane))) return null;
  return { id, tool: tool as WriteGateTool, path: target, cwd, pane: pane ?? null };
}

interface NotifyLabels {
  /** `{task}` is replaced. */
  title: string;
  body: string;
}

/** The system notification raised when a write is held while AiOpt is in the background. */
export const WRITE_REQUEST_NOTIFY_LABELS: Record<MenuLocale, NotifyLabels> = {
  en: { title: 'Task “{task}” is waiting for you', body: 'It wants to write outside the workbench folders.' },
  'zh-CN': { title: '任务「{task}」在等你确认', body: '它想写入工作台文件夹以外的位置。' },
  ja: { title: 'タスク「{task}」が確認を待っています', body: 'ワークベンチのフォルダー外に書き込もうとしています。' },
  ko: { title: '작업 “{task}”이(가) 확인을 기다립니다', body: '워크벤치 폴더 밖에 쓰려고 합니다.' },
  fr: { title: 'La tâche « {task} » attend votre réponse', body: 'Elle veut écrire hors des dossiers de l’atelier.' },
  de: { title: 'Die Aufgabe „{task}“ wartet auf Sie', body: 'Sie möchte außerhalb der Werkbank-Ordner schreiben.' },
  es: {
    title: 'La tarea «{task}» espera tu respuesta',
    body: 'Quiere escribir fuera de las carpetas del banco de trabajo.',
  },
};

export function buildWriteRequestNotification(locale: string, taskTitle: string): { title: string; body: string } {
  const l = WRITE_REQUEST_NOTIFY_LABELS[resolveMenuLocale(locale)];
  return { title: l.title.replace('{task}', displayText(taskTitle, 120)), body: l.body };
}

export interface WriteGateDeps {
  fs: WorkbenchFs;
  dir: string;
  now(): number;
  /** The one live task working in `cwd` (from herdr pane `pane`), or null when none or several could be. */
  taskFor(cwd: string, pane: string | null): { id: string; title: string } | null;
  /** The pending list changed (a request arrived, was answered, or its worker gave up). */
  onChange(): void;
  /** A new request is waiting (raise a notification when the window is in the background). */
  onRequest?: (req: { taskTitle: string }) => void;
  logger: Logger;
}

export interface WriteGate {
  /** Pick up new requests, drop ones whose worker gave up, and sweep stale files. Never throws. */
  pump(): void;
  /** The requests waiting for the user, oldest first. Display data only. */
  pending(): PendingWriteView[];
  /** Answer a waiting request. False when it is not (or no longer) waiting. */
  resolve(id: string, allow: boolean): boolean;
  /** Refuse everything still waiting (the workbench is stopping). */
  denyAll(): void;
}

interface Pending {
  view: PendingWriteView;
  cwd: string;
  pane: string | null;
}

export function createWriteGate(deps: WriteGateDeps): WriteGate {
  /** Ids already seen, so a request is never queued twice (pruned to live ones). */
  const handled = new Set<string>();
  const waiting = new Map<string, Pending>();

  const fileOf = (name: string) => path.join(deps.dir, name);

  function answer(id: string, allow: boolean): void {
    // The worker may have given up (timed out) meanwhile: then there is no one to answer, and
    // a stray answer file would only wait for the sweep.
    if (deps.fs.readFile(fileOf(`${id}.req.json`)) === null) return;
    try {
      deps.fs.writeFile(fileOf(`${id}.res.json`), JSON.stringify({ allow }));
    } catch {
      deps.logger.warn('workbench.write_gate_answer_failed');
    }
  }

  function settle(id: string, allow: boolean, why: 'user' | 'task_gone' | 'stopped'): void {
    const p = waiting.get(id);
    if (!p) return;
    waiting.delete(id);
    deps.logger.info('workbench.write_gate', { tool: p.view.tool, allow, why });
    answer(id, allow);
  }

  function sweep(names: readonly string[]): void {
    const cutoff = deps.now() - WRITE_GATE_TIMEOUT_MS - 60_000;
    for (const name of names) {
      if (!GATE_FILE_RE.test(name)) continue;
      const stat = deps.fs.statFile(fileOf(name));
      if (stat && stat.mtimeMs < cutoff) {
        try {
          deps.fs.removeFile(fileOf(name));
        } catch {
          // Gone already.
        }
      }
    }
  }

  function pump(): void {
    let changed = false;
    try {
      const names = deps.fs.listDir(deps.dir);
      const live = new Set<string>();
      for (const name of names) {
        const id = REQUEST_RE.exec(name)?.[1];
        if (!id) continue;
        live.add(id);
        if (handled.has(id)) continue;
        handled.add(id);
        const file = deps.fs.readRegularFileHead(fileOf(name), MAX_REQUEST_BYTES + 1);
        const req = file && file.size <= MAX_REQUEST_BYTES ? parseWriteGateRequest(name, file.head) : null;
        if (!req) {
          deps.logger.warn('workbench.write_gate_bad_request');
          answer(id, false);
          continue;
        }
        const task = deps.taskFor(req.cwd, req.pane);
        if (!task) {
          // Not a live task's working dir: nobody to ask on its behalf.
          deps.logger.info('workbench.write_gate', { tool: req.tool, allow: false, why: 'unknown_cwd' });
          answer(id, false);
          continue;
        }
        if (waiting.size >= MAX_WAITING) {
          deps.logger.warn('workbench.write_gate_full');
          answer(id, false);
          continue;
        }
        waiting.set(id, {
          cwd: req.cwd,
          pane: req.pane,
          view: {
            id,
            taskId: task.id,
            tool: req.tool,
            path: displayText(req.path, MAX_SHOWN_PATH),
            requestedAt: deps.now(),
          },
        });
        changed = true;
        deps.onRequest?.({ taskTitle: task.title });
      }
      for (const [id, p] of waiting) {
        if (!live.has(id)) {
          // The worker gave up (timed out, or its call was aborted).
          waiting.delete(id);
          changed = true;
        } else if (deps.taskFor(p.cwd, p.pane)?.id !== p.view.taskId) {
          // The task stopped, finished or was removed while the request waited.
          settle(id, false, 'task_gone');
          changed = true;
        }
      }
      // Forget ids whose request is gone, so the set stays bounded.
      for (const id of handled) if (!live.has(id)) handled.delete(id);
      sweep(names);
    } catch {
      deps.logger.warn('workbench.write_gate_failed');
    }
    if (changed) deps.onChange();
  }

  return {
    pump,
    pending: () => [...waiting.values()].map((p) => ({ ...p.view })),
    resolve(id, allow) {
      if (!waiting.has(id)) return false;
      settle(id, allow, 'user');
      deps.onChange();
      return true;
    },
    denyAll() {
      if (waiting.size === 0) return;
      for (const id of [...waiting.keys()]) settle(id, false, 'stopped');
      deps.onChange();
    },
  };
}
