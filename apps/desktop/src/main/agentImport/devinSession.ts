// Devin session reader — reads the Devin CLI's sign-in from credentials.toml.
//
// The file is at ~/.local/share/devin/credentials.toml (XDG_DATA_HOME or APPDATA on
// Windows). The key field is `windsurf_api_key`, the server is `api_server_url`.
// AiOpt only reads the key; no refresh write-back (the CLI manages its own session).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentHome } from '../providers/agentPaths';

export interface DevinSessionSnapshot {
  available: boolean;
  accountLabel: string | null;
}

function credentialsPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    if (appData) return path.join(appData, 'devin', 'credentials.toml');
  }
  const xdgData = process.env.XDG_DATA_HOME?.trim();
  const base = xdgData || path.join(agentHome(), '.local', 'share');
  return path.join(base, 'devin', 'credentials.toml');
}

/** Parse a simple TOML scalar: `key = "value"` or `key = value`. */
function tomlScalar(text: string, key: string): string {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n]*)"?`, 'm');
  const m = text.match(re);
  return m?.[1]?.trim() ?? '';
}

function readCredentials(): { key: string; server: string } | null {
  let text: string;
  try {
    text = fs.readFileSync(credentialsPath(), 'utf8');
  } catch {
    return null;
  }
  const key = tomlScalar(text, 'windsurf_api_key');
  if (key === '') return null;
  let server = tomlScalar(text, 'api_server_url');
  const envServer = process.env.WINDSURF_API_SERVER_URL?.trim();
  if (envServer) server = envServer;
  if (!server) server = 'https://server.codeium.com';
  return { key, server: server.replace(/\/+$/, '') };
}

export function devinCredentialsExist(): boolean {
  try {
    return fs.existsSync(credentialsPath());
  } catch {
    return false;
  }
}

export function devinInstallDirExists(): boolean {
  // Devin keeps credentials under XDG_DATA_HOME, not a dotdir in home.
  // Check both the credentials file and the config dir.
  if (devinCredentialsExist()) return true;
  const cfg = process.env.XDG_CONFIG_HOME?.trim() || path.join(agentHome(), '.config');
  try {
    return fs.existsSync(path.join(cfg, 'devin'));
  } catch {
    return false;
  }
}

export function devinSessionSnapshot(): DevinSessionSnapshot {
  const cred = readCredentials();
  if (!cred) return { available: false, accountLabel: null };
  return { available: true, accountLabel: 'Devin' };
}

export function readDevinAccessTokenSync(): string | null {
  return readCredentials()?.key ?? null;
}

/** The base URL for the Devin API (the server from credentials.toml). */
export function devinApiServer(): string {
  return readCredentials()?.server ?? 'https://server.codeium.com';
}
