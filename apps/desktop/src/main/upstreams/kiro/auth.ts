// Kiro's sign-in, read where kiro-cli or the Kiro IDE keeps it, and its token kept fresh.
//
//   - kiro-cli: the `auth_kv` table of its `data.sqlite3` (read-only via node:sqlite), keys
//     `kirocli:social:token` (Google / GitHub) or `kirocli:odic:token` (AWS Builder ID / IAM
//     Identity Center, its client in `kirocli:odic:device-registration`).
//   - the Kiro IDE: `~/.aws/sso/cache/kiro-auth-token.json` (its client in
//     `<clientIdHash>.json` beside it).
//
// Nothing is copied into AiOpt and nothing is written to either: both are re-read per
// request. A token about to end is renewed by its owner first (`kiro-cli debug
// refresh-auth-token`, then re-read); failing that (the IDE's, or no kiro-cli on PATH) it is
// renewed here and held in memory only — the owner renews its own and the newer is used.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ProxyFetch } from '../../proxy/upstream';
import { agentHome } from '../../providers/agentPaths';

export const KIRO_DESKTOP_UA = 'Kiro-Desktop/0.2.13 (darwin; arm64)';
const EARLY_MS = 2 * 60_000;
const BUILDER_ID_START = 'https://view.awsapps.com/start';
/** The service profile kiro-cli and the IDE use for an AWS Builder ID sign-in. */
export const BUILDER_ID_PROFILE = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX';

export const kiroRuntime = (region: string): string => `https://runtime.${region}.kiro.dev`;
export const kiroManagement = (region: string): string => `https://management.${region}.kiro.dev`;
const refreshUrl = (region: string): string => `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`;
const oidc = (region: string): string => `https://oidc.${region}.amazonaws.com`;

export interface KiroCredential {
  access: string;
  refresh: string;
  /** ms epoch; 0 = unknown. */
  expires: number;
  /** The region it signed in at. */
  region: string;
  profile: string;
  method: 'social' | 'idc';
  builderId: boolean;
  clientId?: string;
  clientSecret?: string;
  source: 'kiro-cli' | 'kiro-ide';
}

/** What a request is signed with. */
export interface KiroAccount {
  token: string;
  profile: string;
  /** The API region (the profile's). */
  region: string;
}

// ---- where kiro-cli and the IDE keep it ------------------------------------------------

export function kiroCliDb(platform: NodeJS.Platform = process.platform): string {
  const home = agentHome();
  if (platform === 'win32') return path.join(process.env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming'), 'kiro-cli', 'data.sqlite3');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
  return path.join(home, '.local', 'share', 'kiro-cli', 'data.sqlite3');
}

export function kiroIdeTokenFile(): string {
  return path.join(agentHome(), '.aws', 'sso', 'cache', 'kiro-auth-token.json');
}

function plainFile(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const time = (v: unknown): number => {
  const t = Date.parse(s(v));
  return Number.isFinite(t) ? t : 0;
};

type DatabaseSyncCtor = typeof import('node:sqlite').DatabaseSync;
let databaseSync: DatabaseSyncCtor | null | undefined;
function sqliteDatabase(): DatabaseSyncCtor | null {
  if (databaseSync !== undefined) return databaseSync;
  try {
    databaseSync = (process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined)?.DatabaseSync ?? null;
  } catch {
    databaseSync = null;
  }
  return databaseSync;
}

function parseObj(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string' || !text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** kiro-cli's sign-in (Google / GitHub, or AWS), or null. A company IdP sign-in is not read. */
export function readKiroCli(): KiroCredential | null {
  const file = kiroCliDb();
  if (!plainFile(file)) return null;
  const DatabaseSync = sqliteDatabase();
  if (!DatabaseSync) return null;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const stmt = db.prepare('SELECT value FROM auth_kv WHERE key = ?');
      const get = (key: string) => {
        const row = stmt.get(key) as { value?: unknown } | undefined;
        const v = row?.value;
        return parseObj(typeof v === 'string' ? v : v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : '');
      };
      for (const kind of ['social', 'odic'] as const) {
        const m = get(`kirocli:${kind}:token`);
        const access = s(m?.access_token);
        if (!m || !access) continue;
        const c: KiroCredential = {
          access,
          refresh: s(m.refresh_token),
          expires: time(m.expires_at),
          region: s(m.region) || 'us-east-1',
          profile: s(m.profile_arn),
          method: kind === 'social' ? 'social' : 'idc',
          builderId: false,
          source: 'kiro-cli',
        };
        if (kind === 'odic') {
          const start = s(m.start_url);
          c.builderId = !start || start === BUILDER_ID_START;
          const reg = get('kirocli:odic:device-registration');
          if (reg) {
            c.clientId = s(reg.client_id);
            c.clientSecret = s(reg.client_secret);
          }
        }
        return c;
      }
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
  return null;
}

function readJson(file: string): Record<string, unknown> | null {
  if (!plainFile(file)) return null;
  try {
    return parseObj(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** The Kiro IDE's sign-in, or null. */
export function readKiroIde(): KiroCredential | null {
  const file = kiroIdeTokenFile();
  const t = readJson(file);
  const access = s(t?.accessToken);
  if (!t || !access) return null;
  const c: KiroCredential = {
    access,
    refresh: s(t.refreshToken),
    expires: time(t.expiresAt),
    region: s(t.region) || 'us-east-1',
    profile: s(t.profileArn),
    method: 'idc',
    builderId: s(t.provider).toLowerCase() === 'builderid',
    source: 'kiro-ide',
  };
  const hash = s(t.clientIdHash);
  if (/^[A-Za-z0-9_-]{1,128}$/.test(hash)) {
    const reg = readJson(path.join(path.dirname(file), `${hash}.json`));
    if (reg) {
      c.clientId = s(reg.clientId);
      c.clientSecret = s(reg.clientSecret);
    }
  }
  if (s(t.authMethod).toLowerCase() === 'social' || !c.clientId) c.method = 'social';
  return c;
}

/** kiro-cli's sign-in, else the IDE's. */
export function readKiro(): KiroCredential | null {
  return readKiroCli() ?? readKiroIde();
}

/** The API region: the profile's, else the nearer of Kiro's two to where it signed in. */
export function kiroRegionOf(profile: string, signedIn: string): string {
  const parts = profile.split(':');
  if (parts.length > 4 && parts[3]) return parts[3];
  return signedIn.startsWith('eu-') ? 'eu-central-1' : 'us-east-1';
}

// ---- kiro-cli, which renews its own ----------------------------------------------------

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function kiroExecutable(): string {
  const win = process.platform === 'win32';
  for (const d of (process.env.PATH ?? '').split(win ? ';' : ':')) {
    const p = d ? path.join(d, win ? 'kiro-cli.exe' : 'kiro-cli') : '';
    if (p && isFile(p)) return p;
  }
  for (const p of [
    path.join(agentHome(), '.local', 'bin', 'kiro-cli'),
    '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli',
    '/usr/local/bin/kiro-cli',
    '/opt/homebrew/bin/kiro-cli',
  ]) {
    if (isFile(p)) return p;
  }
  return '';
}

function runCliRefresh(exe: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(exe, ['debug', 'refresh-auth-token'], { timeout: 20_000, maxBuffer: 1 << 20 }, () => resolve());
  });
}

// ---- the account -----------------------------------------------------------------------

export interface KiroAuthDeps {
  fetchImpl: ProxyFetch;
  read?: () => KiroCredential | null;
  /** kiro-cli's own refresh (null: none installed). */
  cliRefresh?: (() => Promise<void>) | null;
  now?: () => number;
}

export interface KiroAuth {
  /** The account, its token fresh (renewed when `stale`: Kiro turned it down); null when signed out. */
  current(signal?: AbortSignal, stale?: boolean): Promise<KiroAccount | null>;
}

const fresh = (c: KiroCredential, t: number): boolean => !c.expires || c.expires - t > EARLY_MS;

export function createKiroAuth(deps: KiroAuthDeps): KiroAuth {
  const read = deps.read ?? readKiro;
  const now = deps.now ?? Date.now;
  const cliRefresh =
    deps.cliRefresh !== undefined
      ? deps.cliRefresh
      : () => {
          const exe = kiroExecutable();
          return exe ? runCliRefresh(exe) : Promise.resolve();
        };
  /** Renewed here, by the access token each replaced. */
  const after = new Map<string, KiroCredential>();
  const profiles = new Map<string, string>();
  let lock: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };

  async function post(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    let res;
    try {
      res = await deps.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    return parseObj(await res.text().catch(() => ''));
  }

  async function renewHere(c: KiroCredential, signal?: AbortSignal): Promise<KiroCredential | null> {
    if (!c.refresh) return null;
    let access = '';
    let refresh = '';
    let expiresIn = 0;
    let profile = c.profile;
    if (c.method === 'social') {
      const r = await post(refreshUrl(c.region), { refreshToken: c.refresh }, { 'User-Agent': KIRO_DESKTOP_UA }, signal);
      access = s(r?.accessToken);
      refresh = s(r?.refreshToken);
      expiresIn = Number(r?.expiresIn) || 0;
      profile = s(r?.profileArn) || profile;
    } else {
      if (!c.clientId || !c.clientSecret) return null;
      const r = await post(
        `${oidc(c.region)}/token`,
        { clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: c.refresh, grantType: 'refresh_token' },
        {},
        signal,
      );
      access = s(r?.accessToken);
      refresh = s(r?.refreshToken);
      expiresIn = Number(r?.expiresIn) || 0;
    }
    if (!access) return null;
    return { ...c, access, refresh: refresh || c.refresh, profile, expires: now() + (expiresIn > 0 ? expiresIn : 3600) * 1000 };
  }

  async function renew(c: KiroCredential, signal?: AbortSignal): Promise<KiroCredential | null> {
    if (c.source === 'kiro-cli' && cliRefresh) {
      await cliRefresh();
      const n = read();
      if (n && n.source === 'kiro-cli' && n.access !== c.access && fresh(n, now())) return n;
    }
    const n = await renewHere(c, signal);
    if (n) {
      after.set(c.access, n);
      if (after.size > 16) after.delete(after.keys().next().value as string);
    }
    return n;
  }

  /** The profile a sign-in that names none uses: Builder ID's, or the first Kiro lists. */
  async function profileOf(c: KiroCredential, signal?: AbortSignal): Promise<string> {
    if (c.profile) return c.profile;
    if (c.builderId) return BUILDER_ID_PROFILE;
    const known = profiles.get(c.access);
    if (known) return known;
    for (const region of ['us-east-1', 'eu-central-1']) {
      let res;
      try {
        res = await deps.fetchImpl(`${kiroManagement(region)}/List-Available-Profiles`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${c.access}`, Accept: 'application/json', 'Content-Type': 'application/json' },
          body: '{}',
          signal,
        });
      } catch {
        continue;
      }
      const text = await res.text().catch(() => '');
      if (res.status === 403 && c.method === 'idc' && text.includes('Builder ID')) return BUILDER_ID_PROFILE;
      if (!res.ok) continue;
      const list = parseObj(text)?.profiles;
      const arn = Array.isArray(list) ? list.map((p) => s((p as Record<string, unknown> | null)?.arn)).find(Boolean) : '';
      if (arn) {
        profiles.set(c.access, arn);
        return arn;
      }
    }
    return '';
  }

  return {
    current(signal, stale = false) {
      return locked(async () => {
        let c = read();
        if (!c) return null;
        for (let i = 0; i < 16 && after.has(c.access); i++) c = after.get(c.access)!;
        if (stale || !fresh(c, now())) {
          const n = await renew(c, signal);
          if (n) c = n;
          else if (stale || (c.expires && c.expires <= now())) return null;
        }
        const profile = await profileOf(c, signal);
        return { token: c.access, profile, region: kiroRegionOf(profile, c.region) };
      });
    },
  };
}
