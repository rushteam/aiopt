// ZCode session reader — reads the GLM Coding Plan key the ZCode app signed in with.
//
// ZCode keeps its sign-in in `<data>/.zcode/v2/credentials.json`, each value sealed as
// `enc:v1:<iv>.<tag>.<data>` (AES-256-GCM, base64url). The key is SHA-256 of
// `$ZCODE_CREDENTIAL_SECRET`, else of `zcode-credential-fallback:<platform>:<home>:<user>` —
// ZCode's own derivation. `<data>` is the home dir unless `~/.zcode/v2/setting.json` moves it
// (`dataBaseDir`, an absolute path).
//
// Only the Coding Plan API key is imported (entries `…:coding-plan:…:api-key`, or ZCode
// 3.15's `config.json` `provider[builtin:*-coding-plan].options.apiKey`). It is served on the
// plan's Anthropic endpoint (Z.ai's, or BigModel's for a BigModel key) by the ordinary HTTP
// path. ZCode's own session JWT (the free Start Plan) and team seats are not imported.
//
// Read-only: AiOpt never writes these files, and the key never crosses IPC. It is read again
// at request time.

import { createDecipheriv, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentHome } from '../providers/agentPaths';

export const ZCODE_ZAI_BASE = 'https://api.z.ai/api/anthropic';
export const ZCODE_BIGMODEL_BASE = 'https://open.bigmodel.cn/api/anthropic';

export interface ZcodeSessionSnapshot {
  available: boolean;
  accountLabel: string | null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `~/.zcode/v2` — where setting.json always lives. */
function settingDir(): string {
  return path.join(agentHome(), '.zcode', 'v2');
}

export function zcodeInstallDirExists(): boolean {
  try {
    return fs.existsSync(path.join(agentHome(), '.zcode'));
  } catch {
    return false;
  }
}

/** `<data>/.zcode/v2` — credentials.json and config.json, moved by `dataBaseDir`. */
function dataDir(): string {
  const d = readJson(path.join(settingDir(), 'setting.json'))?.dataBaseDir;
  const t = typeof d === 'string' ? d.trim() : '';
  // A sandboxed run never follows a setting to a real data dir outside the sandbox.
  if (t && path.isAbsolute(t) && !process.env.AIOPT_AGENT_HOME) return path.join(t, '.zcode', 'v2');
  return settingDir();
}

/** ZCode's credential key: SHA-256 of the secret env, else of its machine fallback seed. */
export function zcodeSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
  let seed = env.ZCODE_CREDENTIAL_SECRET;
  if (!seed) {
    let name = '';
    try {
      name = os.userInfo().username;
    } catch {
      /* no user name */
    }
    name = name.slice(name.lastIndexOf('\\') + 1);
    seed = `zcode-credential-fallback:${process.platform}:${os.homedir()}:${name}`;
  }
  return createHash('sha256').update(seed).digest();
}

/** Open one `enc:v1:` value, or null (not sealed, wrong key, tampered). */
export function zcodeDecrypt(key: Buffer, v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith('enc:v1:')) return null;
  const parts = v.slice(7).split('.');
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, data] = parts.map((p) => Buffer.from(p.replace(/=+$/, ''), 'base64url'));
    const d = createDecipheriv('aes-256-gcm', key, iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(data!), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

interface ZcodeKey {
  key: string;
  base: string;
  label: string | null;
}

const looksLikeKey = (k: string): boolean => k.includes('.') && !/[\s{$]/.test(k);

function configKey(secret: Buffer): { key: string; base: string } | null {
  const providers = readJson(path.join(dataDir(), 'config.json'))?.provider;
  if (!providers || typeof providers !== 'object') return null;
  const table: Array<[string[], string]> = [
    [['builtin:zai-coding-plan', 'account:zai-individual-coding-plan'], ZCODE_ZAI_BASE],
    [['builtin:bigmodel-coding-plan', 'account:bigmodel-individual-coding-plan'], ZCODE_BIGMODEL_BASE],
  ];
  for (const [ids, base] of table) {
    for (const id of ids) {
      const opts = (providers as Record<string, { options?: { apiKey?: unknown } } | undefined>)[id]?.options;
      let k = typeof opts?.apiKey === 'string' ? opts.apiKey.trim() : '';
      if (k.startsWith('enc:')) k = (zcodeDecrypt(secret, k) ?? '').trim();
      if (k && looksLikeKey(k)) return { key: k, base };
    }
  }
  return null;
}

function who(info: Record<string, unknown>): string | null {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return s(info.email).replace(/@phone\.local$/, '') || s(info.name) || s(info.user_id) || null;
}

function readKey(): ZcodeKey | null {
  const store = readJson(path.join(dataDir(), 'credentials.json'));
  const secret = zcodeSecret();
  let found: { key: string; base: string } | null = null;
  for (const [name, v] of Object.entries(store ?? {})) {
    if (!name.includes(':coding-plan:') || !name.endsWith(':api-key')) continue;
    const k = zcodeDecrypt(secret, v)?.trim();
    if (!k || !looksLikeKey(k)) continue;
    const base = name.includes(':bigmodel-') ? ZCODE_BIGMODEL_BASE : ZCODE_ZAI_BASE;
    // Z.ai's first, as ZCode lists it.
    if (!found || (base === ZCODE_ZAI_BASE && found.base !== ZCODE_ZAI_BASE)) found = { key: k, base };
  }
  found ??= configKey(secret);
  if (!found) return null;
  let label: string | null = null;
  for (const name of ['oauth:zai:user_info', 'oauth:bigmodel:user_info']) {
    const raw = zcodeDecrypt(secret, store?.[name]);
    if (!raw || label) continue;
    try {
      const info: unknown = JSON.parse(raw);
      if (info && typeof info === 'object') label = who(info as Record<string, unknown>);
    } catch {
      /* unreadable user info */
    }
  }
  return { ...found, label };
}

export function zcodeSessionSnapshot(): ZcodeSessionSnapshot {
  const k = readKey();
  if (!k) return { available: false, accountLabel: null };
  return { available: true, accountLabel: k.label ?? (k.base === ZCODE_BIGMODEL_BASE ? 'BigModel' : 'Z.ai') };
}

export function readZcodeAccessTokenSync(): string | null {
  return readKey()?.key ?? null;
}

/** The plan endpoint the imported key belongs to (Z.ai's unless the key is BigModel's). */
export function zcodeBaseUrl(): string {
  return readKey()?.base ?? ZCODE_ZAI_BASE;
}
