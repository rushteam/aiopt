// The cursor-agent CLI, as the Cursor provider uses it: the version the agent API is told
// it is talking to (it turns away versions it no longer supports), and a way to renew a
// session token that is about to run out (`cursor-agent status` refreshes it in place).
//
// AiOpt never writes cursor-agent's sign-in; it only reads it (agentImport/cursorSession.ts) and asks
// cursor-agent itself to renew it. No output of the CLI is logged.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agentHome } from '../../providers/agentPaths';
import { jwtExpMs } from '../../agentImport/jwtPayload';
import { readCursorAccessTokenSync } from '../../agentImport/cursorSession';

const VERSION_RE = /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/;
export const CURSOR_VERSION_FALLBACK = '2026.09.23-86fc751';
/** Renew when the token has less than this left. */
const RENEW_BEFORE_MS = 5 * 60_000;

function exists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** The cursor-agent executable (or Cursor's `agent` by that name), or "" when none. */
export function cursorExecutable(): string {
  const win = process.platform === 'win32';
  const dirs = (process.env.PATH ?? '').split(win ? ';' : ':').filter(Boolean);
  for (const name of ['cursor-agent', 'agent']) {
    for (const d of dirs) {
      const p = path.join(d, win ? `${name}.exe` : name);
      if (!exists(p)) continue;
      if (name === 'cursor-agent') return p;
      if (realpath(p).includes('cursor-agent')) return p;
    }
  }
  const home = agentHome();
  for (const p of [path.join(home, '.local', 'bin', 'cursor-agent'), '/usr/local/bin/cursor-agent', '/opt/homebrew/bin/cursor-agent']) {
    if (exists(p)) return p;
  }
  return '';
}

let versionSaid = '';

/** `cli-<version>` of the installed cursor-agent (or a recent fallback). */
export function cursorClientVersion(): string {
  if (versionSaid) return versionSaid;
  let v = '';
  const exe = cursorExecutable();
  if (exe) {
    const d = path.basename(path.dirname(realpath(exe)));
    if (VERSION_RE.test(d)) v = d;
  }
  if (!v) {
    const dirs = [path.join(agentHome(), '.local', 'share', 'cursor-agent', 'versions')];
    if (process.platform === 'win32') dirs.push(path.join(process.env.LOCALAPPDATA ?? '', 'cursor-agent', 'versions'));
    for (const dir of dirs) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) if (VERSION_RE.test(n) && n > v) v = n;
    }
  }
  versionSaid = 'cli-' + (v || CURSOR_VERSION_FALLBACK);
  return versionSaid;
}

let renewing: Promise<void> | null = null;

function runStatus(exe: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(exe, ['status'], { timeout: 30_000, maxBuffer: 1 << 20 }, () => resolve());
  });
}

/**
 * The cursor-agent session's token, renewed through `cursor-agent status` when it has
 * under five minutes left. Null when signed out or when it has run out and can't be renewed.
 */
export async function cursorAccessToken(): Promise<string | null> {
  let tok = readCursorAccessTokenSync();
  const exp = tok ? jwtExpMs(tok) : null;
  if (tok && (exp === null || exp - Date.now() > RENEW_BEFORE_MS)) return tok;
  const exe = cursorExecutable();
  if (exe) {
    renewing ??= runStatus(exe).finally(() => {
      renewing = null;
    });
    await renewing;
    tok = readCursorAccessTokenSync();
  }
  if (!tok) return null;
  const e = jwtExpMs(tok);
  if (e !== null && e <= Date.now()) return null;
  return tok;
}
