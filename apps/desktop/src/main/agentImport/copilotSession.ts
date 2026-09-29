import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { agentHome } from '../providers/agentPaths';

export interface CopilotSessionSnapshot {
  available: boolean;
  accountLabel: string | null;
}

function xdgConfigHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return xdg;
  return path.join(agentHome(), '.config');
}

function copilotCliHome(): string {
  const home = process.env.COPILOT_HOME?.trim();
  if (home) return home;
  return path.join(agentHome(), '.copilot');
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function keychainToken(account: string): string | null {
  if (os.platform() !== 'darwin') return null;
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', 'copilot-cli', '-a', account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const tok = out.trim();
    return tok === '' ? null : tok;
  } catch {
    return null;
  }
}

function fromEditorAppsJson(): { user: string; token: string } | null {
  const cfg = xdgConfigHome();
  for (const name of ['apps.json', 'hosts.json']) {
    const doc = readJsonFile(path.join(cfg, 'github-copilot', name));
    if (!doc) continue;
    for (const [key, value] of Object.entries(doc)) {
      if (!key.startsWith('github.com')) continue;
      if (!value || typeof value !== 'object') continue;
      const row = value as Record<string, unknown>;
      const token = typeof row.oauth_token === 'string' ? row.oauth_token : '';
      const user = typeof row.user === 'string' ? row.user : key.replace(/^github\.com[:/]/, '');
      if (token !== '') return { user, token };
    }
  }
  return null;
}

function fromCopilotCli(): { user: string; token: string } | null {
  const doc = readJsonFile(path.join(copilotCliHome(), 'config.json'));
  if (!doc) return null;
  const tokens =
    doc.copilotTokens && typeof doc.copilotTokens === 'object'
      ? (doc.copilotTokens as Record<string, string>)
      : {};
  const users: { host?: string; login: string }[] = [];
  if (doc.lastLoggedInUser && typeof doc.lastLoggedInUser === 'object') {
    const u = doc.lastLoggedInUser as Record<string, unknown>;
    if (typeof u.login === 'string') users.push({ host: typeof u.host === 'string' ? u.host : undefined, login: u.login });
  }
  if (Array.isArray(doc.loggedInUsers)) {
    for (const entry of doc.loggedInUsers) {
      if (entry && typeof entry === 'object') {
        const u = entry as Record<string, unknown>;
        if (typeof u.login === 'string') {
          users.push({ host: typeof u.host === 'string' ? u.host : undefined, login: u.login });
        }
      }
    }
  }
  for (const u of users) {
    if (u.host && u.host !== 'https://github.com') continue;
    const key = `https://github.com:${u.login}`;
    let token = tokens[key] ?? '';
    if (token === '') token = keychainToken(key) ?? '';
    if (token !== '') return { user: u.login, token };
  }
  return null;
}

export function copilotInstallDirExists(): boolean {
  if (fs.existsSync(copilotCliHome())) return true;
  if (fs.existsSync(path.join(xdgConfigHome(), 'github-copilot'))) return true;
  return false;
}

export function copilotSessionSnapshot(): CopilotSessionSnapshot {
  const hit = fromEditorAppsJson() ?? fromCopilotCli();
  if (!hit) return { available: false, accountLabel: null };
  return { available: true, accountLabel: hit.user || 'GitHub' };
}

export function readCopilotAccessTokenSync(): string | null {
  const hit = fromEditorAppsJson() ?? fromCopilotCli();
  return hit?.token ?? null;
}
