// dsh (DeepSeek Harness) session reader — reads the DeepSeek API key dsh itself uses.
//
// dsh keeps secrets in `$DSH_HOME/.credentials.yaml` (default `~/.dsh`), written 0600 by
// dsh. Its official DeepSeek provider (`llm-deepseek-api-key`) resolves the credential
// reference `DEEPSEEK_API_KEY`. Two layouts exist:
//
//   version: 1                     # current
//   refs:
//     DEEPSEEK_API_KEY: sk-…
//
//   DEEPSEEK_API_KEY: sk-…         # pre-release flat layout
//
// Only that one reference is read. The `AIOPT_*_KEY` refs AiOpt's own dsh binding writes
// are never picked up, so a pool provider can't end up importing its own key. dsh's
// DeepSeek *account* sign-in (`x-dsh-auth-token`) is a dsh-private API and is not imported.
//
// Read-only: AiOpt never writes this file for an import, and the key never crosses IPC.
// It is read again at request time, so a key rotated in dsh takes effect without re-import.

import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { agentHome } from '../providers/agentPaths';

export const DSH_DEEPSEEK_REF = 'DEEPSEEK_API_KEY';

export interface DshSessionSnapshot {
  available: boolean;
  accountLabel: string | null;
}

function dshHome(): string {
  // `$DSH_HOME` is dsh's own override; a dev/test sandbox (`AIOPT_AGENT_HOME`) still wins so a
  // run never reads the developer's real key.
  const override = process.env.DSH_HOME?.trim();
  if (override && !process.env.AIOPT_AGENT_HOME) return override;
  return path.join(agentHome(), '.dsh');
}

function credentialsPath(): string {
  return path.join(dshHome(), '.credentials.yaml');
}

export function dshInstallDirExists(): boolean {
  try {
    return fs.existsSync(dshHome());
  } catch {
    return false;
  }
}

/** The DeepSeek API key dsh would send, or `null` (missing file, bad YAML, no such ref). */
function readKey(): string | null {
  let text: string;
  try {
    // Not following a symlink: the file is a secret store, and dsh itself writes a plain file.
    if (fs.lstatSync(credentialsPath()).isSymbolicLink()) return null;
    text = fs.readFileSync(credentialsPath(), 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) return null;
  const root: unknown = doc.toJS();
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  const fields = root as Record<string, unknown>;
  const refs = 'version' in fields ? fields.refs : fields;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return null;
  const key = (refs as Record<string, unknown>)[DSH_DEEPSEEK_REF];
  return typeof key === 'string' && key.trim() !== '' ? key.trim() : null;
}

export function dshSessionSnapshot(): DshSessionSnapshot {
  return readKey() ? { available: true, accountLabel: DSH_DEEPSEEK_REF } : { available: false, accountLabel: null };
}

export function readDshAccessTokenSync(): string | null {
  return readKey();
}
