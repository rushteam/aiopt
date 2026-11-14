import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger';
import { WORKER_EXTENSION_SOURCE } from '../workerExtension';
import {
  WRITE_GATE_TIMEOUT_MS,
  WRITE_REQUEST_NOTIFY_LABELS,
  buildWriteRequestNotification,
  createWriteGate,
  parseWriteGateRequest,
} from '../writeGate';
import type { WorkbenchFs } from '../workbenchManager';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const REQ = `${ID}.req.json`;
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const ok = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, tool: 'edit', path: '/etc/hosts', cwd: '/work/app', ...over });

describe('parseWriteGateRequest', () => {
  it('reads a well-formed request', () => {
    expect(parseWriteGateRequest(REQ, ok())).toEqual({
      id: ID,
      tool: 'edit',
      path: '/etc/hosts',
      cwd: '/work/app',
      pane: null,
    });
    expect(parseWriteGateRequest(REQ, ok({ pane: 'wA:p1' }))?.pane).toBe('wA:p1');
  });

  it('refuses anything else', () => {
    expect(parseWriteGateRequest('x.req.json', ok())).toBeNull();
    expect(parseWriteGateRequest(`${ID}.res.json`, ok())).toBeNull();
    expect(parseWriteGateRequest(REQ, '{')).toBeNull();
    expect(parseWriteGateRequest(REQ, 'null')).toBeNull();
    expect(parseWriteGateRequest(REQ, ok({ v: 2 }))).toBeNull();
    expect(parseWriteGateRequest(REQ, ok({ tool: 'bash' }))).toBeNull();
    expect(parseWriteGateRequest(REQ, ok({ path: '' }))).toBeNull();
    expect(parseWriteGateRequest(REQ, ok({ path: 'x'.repeat(5000) }))).toBeNull();
    expect(parseWriteGateRequest(REQ, ok({ cwd: 7 }))).toBeNull();
    expect(parseWriteGateRequest(REQ, ok({ pane: 'w1:p1; rm' }))).toBeNull();
    expect(parseWriteGateRequest(REQ, ok({ pane: 3 }))).toBeNull();
  });
});

describe('buildWriteRequestNotification', () => {
  it('has every label in every locale', () => {
    for (const labels of Object.values(WRITE_REQUEST_NOTIFY_LABELS)) {
      expect(labels.title).toContain('{task}');
      expect(labels.body.trim()).not.toBe('');
    }
  });

  it('names the task with nothing that could disguise it', () => {
    expect(buildWriteRequestNotification('zh-Hans-CN', 'Fix\u0007 \u202Eit')).toEqual({
      title: '任务「Fix it」在等你确认',
      body: '它想写入工作台文件夹以外的位置。',
    });
  });
});

function memFs(files: Map<string, { text: string; mtimeMs: number }>): WorkbenchFs {
  return {
    mkdirp: () => {},
    writeFile: (file, contents) => void files.set(file, { text: String(contents), mtimeMs: 0 }),
    readFile: (file) => files.get(file)?.text ?? null,
    isDirectory: () => false,
    realpath: (p) => p,
    // Keys are `path.join`ed (backslashes on Windows); compare like for like.
    listDir: (dir) =>
      [...files.keys()].filter((f) => path.dirname(f) === path.normalize(dir)).map((f) => path.basename(f)),
    listDirEntries: () => [],
    statFile: (file) => {
      const f = files.get(file);
      return f ? { size: f.text.length, mtimeMs: f.mtimeMs } : null;
    },
    readFileHead: (file, max) => files.get(file)?.text.slice(0, max) ?? null,
    readRegularFileHead: (file, max) => {
      const f = files.get(file);
      return f ? { head: f.text.slice(0, max), size: f.text.length } : null;
    },
    removeFile: (file) => void files.delete(file),
  };
}

describe('createWriteGate', () => {
  const DIR = '/data/write-gate';
  const SECOND = 'bbbbbbbb-0000-4000-8000-000000000002';
  type Files = Map<string, { text: string; mtimeMs: number }>;
  const res = (files: Files, id: string) => {
    const f = files.get(path.join(DIR, `${id}.res.json`));
    return f ? JSON.parse(f.text) : undefined;
  };
  function gateWith(files: Files, task: { id: string; title: string } | null = { id: 't1', title: 'T' }) {
    const onChange = vi.fn();
    const onRequest = vi.fn();
    let current = task;
    const gate = createWriteGate({
      fs: memFs(files),
      dir: DIR,
      now: () => 5,
      taskFor: () => current,
      onChange,
      onRequest,
      logger: silent,
    });
    return { gate, onChange, onRequest, setTask: (next: typeof task) => (current = next) };
  }

  it('lists a request until the user answers it, once', () => {
    const files: Files = new Map([
      [path.join(DIR, REQ), { text: ok({ path: '/tmp/\u202Etxt.exe\nx' }), mtimeMs: 0 }],
      [path.join(DIR, `${SECOND}.req.json`), { text: ok({ tool: 'write' }), mtimeMs: 0 }],
    ]);
    const { gate, onChange, onRequest } = gateWith(files);
    gate.pump();
    gate.pump();
    expect(gate.pending()).toEqual([
      { id: ID, taskId: 't1', tool: 'edit', path: '/tmp/txt.exe x', requestedAt: 5 },
      { id: SECOND, taskId: 't1', tool: 'write', path: '/etc/hosts', requestedAt: 5 },
    ]);
    expect(onRequest).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(res(files, ID)).toBeUndefined();

    expect(gate.resolve(ID, true)).toBe(true);
    expect(res(files, ID)).toEqual({ allow: true });
    expect(gate.resolve(ID, false)).toBe(false);
    expect(res(files, ID)).toEqual({ allow: true });
    expect(gate.resolve('cccccccc-0000-4000-8000-000000000003', true)).toBe(false);
    expect(gate.pending().map((r) => r.id)).toEqual([SECOND]);
  });

  it('drops a request whose worker gave up, without answering it', () => {
    const files: Files = new Map([[path.join(DIR, REQ), { text: ok(), mtimeMs: 0 }]]);
    const { gate, onChange } = gateWith(files);
    gate.pump();
    files.delete(path.join(DIR, REQ));
    gate.pump();
    expect(gate.pending()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(gate.resolve(ID, true)).toBe(false);
    expect(res(files, ID)).toBeUndefined();
  });

  it('refuses when the task is gone, and everything when stopping', () => {
    const files: Files = new Map([[path.join(DIR, REQ), { text: ok(), mtimeMs: 0 }]]);
    const { gate, setTask } = gateWith(files);
    gate.pump();
    setTask({ id: 'other', title: 'O' });
    gate.pump();
    expect(gate.pending()).toEqual([]);
    expect(res(files, ID)).toEqual({ allow: false });

    files.set(path.join(DIR, `${SECOND}.req.json`), { text: ok(), mtimeMs: 0 });
    gate.pump();
    expect(gate.pending()).toHaveLength(1);
    gate.denyAll();
    expect(gate.pending()).toEqual([]);
    expect(res(files, SECOND)).toEqual({ allow: false });
  });

  it('refuses a malformed request, or one from no live task, without listing it', () => {
    const files: Files = new Map([[path.join(DIR, REQ), { text: '{bad', mtimeMs: 0 }]]);
    const a = gateWith(files);
    a.gate.pump();
    expect(res(files, ID)).toEqual({ allow: false });
    expect(a.gate.pending()).toEqual([]);

    const files2: Files = new Map([[path.join(DIR, REQ), { text: ok(), mtimeMs: 0 }]]);
    const b = gateWith(files2, null);
    b.gate.pump();
    expect(res(files2, ID)).toEqual({ allow: false });
    expect(b.gate.pending()).toEqual([]);
    expect(b.onRequest).not.toHaveBeenCalled();
  });

  it('holds at most 20 at once', () => {
    const files: Files = new Map();
    const ids = Array.from({ length: 21 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`);
    for (const id of ids) files.set(path.join(DIR, `${id}.req.json`), { text: ok(), mtimeMs: 0 });
    const { gate } = gateWith(files);
    gate.pump();
    expect(gate.pending()).toHaveLength(20);
    expect(res(files, ids[20]!)).toEqual({ allow: false });
  });

  it('sweeps what a dead worker left behind, and nothing else', () => {
    const now = WRITE_GATE_TIMEOUT_MS * 3;
    const files: Files = new Map([
      [path.join(DIR, `${ID}.res.json`), { text: '{}', mtimeMs: 0 }],
      [path.join(DIR, 'notes.txt'), { text: 'x', mtimeMs: 0 }],
      [path.join(DIR, `${SECOND}.res.json`), { text: '{}', mtimeMs: now }],
    ]);
    createWriteGate({
      fs: memFs(files),
      dir: DIR,
      now: () => now,
      taskFor: () => null,
      onChange: () => {},
      logger: silent,
    }).pump();
    expect([...files.keys()].map((f) => path.basename(f)).sort()).toEqual([`${SECOND}.res.json`, 'notes.txt']);
  });
});

// The worker extension, run for real in a node child against a temp directory.
describe.skipIf(process.platform === 'win32')('worker extension', () => {
  type Result = { block: true; reason: string } | null;
  let root: string;
  let answer: ReturnType<typeof setInterval>;
  let allow = false;
  const asked: string[] = [];

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-wgate-')));
    for (const d of ['cwd', 'granted', 'outside', 'gate']) fs.mkdirSync(path.join(root, d));
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'cwd', 'link'));
    fs.writeFileSync(
      path.join(root, 'folders.json'),
      JSON.stringify({ folders: [{ path: path.join(root, 'granted') }] }),
    );
    fs.writeFileSync(path.join(root, 'worker-extension.mjs'), WORKER_EXTENSION_SOURCE);
    // Loads the extension as pi does and runs the tool calls it is given.
    fs.writeFileSync(
      path.join(root, 'run.mjs'),
      [
        'import ext from "./worker-extension.mjs";',
        'let h;',
        'ext({ on: (_n, fn) => (h = fn) });',
        'const [cwd, calls] = JSON.parse(process.argv[2]);',
        'const out = [];',
        'for (const [toolName, p] of calls) out.push((await h({ toolName, input: { path: p } }, { cwd })) ?? null);',
        'process.stdout.write(JSON.stringify(out));',
      ].join('\n'),
    );
    // Stands in for main: answers every request it sees.
    answer = setInterval(() => {
      const dir = path.join(root, 'gate');
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.req.json')) continue;
        try {
          const req = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { path: string };
          if (!asked.includes(req.path)) asked.push(req.path);
          fs.writeFileSync(path.join(dir, name.replace('.req.', '.res.')), JSON.stringify({ allow }));
        } catch {
          // The worker took its answer and cleaned up meanwhile.
        }
      }
    }, 50);
  });

  afterAll(() => {
    clearInterval(answer);
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function run(calls: [string, unknown][], gate = true): Promise<Result[]> {
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: os.homedir() };
    env.AIOPT_WB_FOLDERS_FILE = path.join(root, 'folders.json');
    if (gate) env.AIOPT_WB_WRITE_GATE_DIR = path.join(root, 'gate');
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.join(root, 'run.mjs'), JSON.stringify([path.join(root, 'cwd'), calls])],
      { env, cwd: root },
    );
    return JSON.parse(stdout) as Result[];
  }

  it('lets writes inside the task folder and granted folders through', async () => {
    const results = await run([
      ['write', 'src/a.ts'],
      ['edit', '@src/a.ts'],
      ['write', path.join(root, 'granted', 'new', 'b.md')],
      ['read', '/etc/hosts'],
    ]);
    expect(results).toEqual([null, null, null, null]);
    expect(asked).toEqual([]);
  });

  it('holds writes outside them (through .., ~ and symlinks) for the user', async () => {
    allow = false;
    const denied = await run([
      ['write', '../outside/x.txt'],
      ['edit', 'link/y.txt'],
      ['write', '~/aiopt-wgate-never-written'],
    ]);
    expect(denied.map((r) => r?.block)).toEqual([true, true, true]);
    expect(denied[0]!.reason).toContain(path.join(root, 'outside', 'x.txt'));
    expect(asked).toEqual([
      path.join(root, 'outside', 'x.txt'),
      path.join(root, 'outside', 'y.txt'),
      path.join(os.homedir(), 'aiopt-wgate-never-written'),
    ]);
    allow = true;
    expect(await run([['write', '../outside/z.txt']])).toEqual([null]);
    // Every request and answer is cleaned up.
    expect(fs.readdirSync(path.join(root, 'gate'))).toEqual([]);
  });

  it('blocks outright when there is no AiOpt to ask', async () => {
    const [result] = await run([['write', '../outside/w.txt']], false);
    expect(result).toMatchObject({ block: true });
  });
});
