// The real (Node) side effects behind the workbench manager. Electron-free; services.ts adds
// the Electron-derived paths and the providers/proxy lookups.

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from '../storeFile';
import { findBinary as findIn, type ExecResult } from './herdrCli';
import type { PiChild } from './piRpc';
import type { WorkbenchDeps, WorkbenchFs } from './workbenchManager';

const MAX_OUTPUT = 4 * 1024 * 1024;

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export const nodeWorkbenchFs: WorkbenchFs = {
  mkdirp: (dir) => void fs.mkdirSync(dir, { recursive: true, mode: 0o700 }),
  writeFile: (file, contents) => writeFileAtomicSync(file, contents),
  readFile: (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  isDirectory: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  realpath: (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  },
  listDir: (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  },
  statFile: (file) => {
    try {
      // lstat: a symlink is not a regular file, so a planted link is never followed.
      const st = fs.lstatSync(file);
      return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
    } catch {
      return null;
    }
  },
  readFileHead: (file, maxBytes) => {
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(maxBytes);
      const n = fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.subarray(0, n).toString('utf8');
    } catch {
      return null;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  },
  removeFile: (file) => fs.unlinkSync(file),
};

function execNode(
  file: string,
  args: readonly string[],
  timeoutMs: number,
  env: Record<string, string>,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, env, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 0;
        // A spawn failure (ENOENT) or a timeout kill has no numeric exit code.
        if (err && typeof (err as { code?: unknown }).code !== 'number') {
          reject(err);
          return;
        }
        resolve({ code, stdout, stderr });
      },
    );
  });
}

export type NodeWorkbenchDeps = Pick<
  WorkbenchDeps,
  'fs' | 'findBinary' | 'exec' | 'spawnDetached' | 'spawnPi' | 'isGitRepo' | 'now' | 'sleep' | 'every' | 'randomId'
>;

export function createNodeWorkbenchDeps(): NodeWorkbenchDeps {
  let gitBinary: string | null | undefined;
  return {
    fs: nodeWorkbenchFs,
    findBinary: (name, dirs) => findIn(name, dirs, isExecutable),
    exec: execNode,
    spawnDetached: (file, args, env, cwd) => {
      const child = spawn(file, [...args], { detached: true, stdio: 'ignore', env, cwd });
      child.on('error', () => {});
      child.unref();
    },
    spawnPi: (file, args, env, cwd) => {
      // stderr is discarded, not logged: it can echo prompt text or file contents.
      const child = spawn(file, [...args], { stdio: ['pipe', 'pipe', 'ignore'], env, cwd });
      return child as unknown as PiChild;
    },
    isGitRepo: async (dir) => {
      if (gitBinary === undefined) {
        gitBinary = findIn('git', ['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin'], isExecutable);
      }
      if (!gitBinary) return false;
      try {
        const out = await execNode(gitBinary, ['-C', dir, 'rev-parse', '--is-inside-work-tree'], 5000, {
          PATH: path.dirname(gitBinary),
        });
        return out.code === 0 && out.stdout.trim() === 'true';
      } catch {
        return false;
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    every: (ms, fn) => {
      const timer = setInterval(fn, ms);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    randomId: () => {
      // 10 chars of [a-z0-9] from 10 random bytes (the alphabet bias is irrelevant for ids).
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
      return [...randomBytes(10)].map((b) => alphabet[b % alphabet.length]).join('');
    },
  };
}
