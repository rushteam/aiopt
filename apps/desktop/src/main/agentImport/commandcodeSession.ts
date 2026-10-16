// Command Code session reader — reads the Provider API key Command Code's CLI signed in with.
//
// `commandcode login` writes `~/.commandcode/auth.json` ({ apiKey, userName?, userId?, … }).
// The key is a plain Provider API key: Command Code's Provider API takes it as a bearer token
// (Chat Completions) and as `x-api-key` (Messages), so the ordinary HTTP path serves it.
// A Go-plan key (served only at the CLI's private `/alpha/generate`) is not supported here.
//
// Read-only: AiOpt never writes this file, and the key never crosses IPC. It is read again at
// request time, so a re-login in the CLI takes effect without re-import.

import fs from 'node:fs';
import path from 'node:path';
import { agentHome } from '../providers/agentPaths';

export interface CommandCodeSessionSnapshot {
  available: boolean;
  accountLabel: string | null;
}

function commandcodeHome(): string {
  return path.join(agentHome(), '.commandcode');
}

function authPath(): string {
  return path.join(commandcodeHome(), 'auth.json');
}

export function commandcodeInstallDirExists(): boolean {
  try {
    return fs.existsSync(commandcodeHome());
  } catch {
    return false;
  }
}

interface CommandCodeAuth {
  key: string;
  label: string | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function readAuth(): CommandCodeAuth | null {
  let raw: unknown;
  try {
    if (fs.lstatSync(authPath()).isSymbolicLink()) return null;
    raw = JSON.parse(fs.readFileSync(authPath(), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const key = str(a.apiKey);
  if (!key) return null;
  const label = str(a.userName) || str(a.email) || null;
  return { key, label };
}

export function commandcodeSessionSnapshot(): CommandCodeSessionSnapshot {
  const a = readAuth();
  if (!a) return { available: false, accountLabel: null };
  return { available: true, accountLabel: a.label ?? 'Command Code' };
}

export function readCommandCodeAccessTokenSync(): string | null {
  return readAuth()?.key ?? null;
}
