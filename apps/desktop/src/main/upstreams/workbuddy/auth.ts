// WorkBuddy desktop's sign-in, read where the app keeps it, and its token kept fresh.
//
// WorkBuddy (Tencent's CodeBuddy desktop agent, China build) keeps its sign-in in
// `<CodeBuddyExtension>/Data/Public/auth/workbuddy-desktop.info` (plain JSON:
// `{ account: { uid, nickname, enterpriseId? }, auth: { accessToken, refreshToken, expiresAt,
// refreshExpiresAt, domain } }`). WorkBuddy 5.6+ seals the tokens (`{ $wbEncrypted }`), which
// only the app opens: such a file reads as signed out.
//
// Nothing is copied into AiOpt and nothing is written back to the app's file: the file is
// re-read per request, and a token renewed here (within a minute of its end) is held in
// memory only — the app renews its own and the newer of the two is used.

import fs from 'node:fs';
import path from 'node:path';
import type { ProxyFetch } from '../../proxy/upstream';
import { agentHome } from '../../providers/agentPaths';

export const WORKBUDDY_ENDPOINT = 'https://copilot.tencent.com';
export const WORKBUDDY_UA_VERSION = '5.5.6';
const EARLY_MS = 60_000;

export interface WorkBuddyAccount {
  access: string;
  refresh: string;
  /** ms epoch; 0 = unknown. */
  expires: number;
  refreshExpiresAt: number;
  domain: string;
  uid: string;
  enterpriseId?: string;
  name: string;
}

/** `CodeBuddyExtension` — the app's data root, per platform (under the sandboxable home). */
export function workbuddyDataRoot(platform: NodeJS.Platform = process.platform): string {
  const home = agentHome();
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension');
  if (platform === 'win32') return path.join(home, 'AppData', 'Local', 'CodeBuddyExtension');
  return path.join(home, '.local', 'share', 'CodeBuddyExtension');
}

export function workbuddyAuthFile(): string {
  return path.join(workbuddyDataRoot(), 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
}

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** The desktop sign-in, or null (none, sealed, unreadable). */
export function readWorkBuddyDesktop(now = Date.now()): WorkBuddyAccount | null {
  let f: unknown;
  try {
    const file = workbuddyAuthFile();
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    f = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (!f || typeof f !== 'object') return null;
  const o = f as { account?: Record<string, unknown>; auth?: Record<string, unknown> };
  const t = o.auth ?? {};
  const acct = o.account ?? {};
  const access = s(t.accessToken);
  const uid = s(acct.uid);
  if (!access || !uid) return null;
  const enterpriseId = s(acct.enterpriseId);
  return {
    access,
    refresh: s(t.refreshToken),
    expires: n(t.expiresAt) || (n(t.expiresIn) ? now + n(t.expiresIn) * 1000 : 0),
    refreshExpiresAt: n(t.refreshExpiresAt) || (n(t.refreshExpiresIn) ? now + n(t.refreshExpiresIn) * 1000 : 0),
    domain: s(t.domain),
    uid,
    ...(enterpriseId ? { enterpriseId } : {}),
    name: s(acct.nickname) || uid,
  };
}

export function workbuddyDomain(a: WorkBuddyAccount): string {
  return a.domain || new URL(WORKBUDDY_ENDPOINT).host;
}

/** X-Enterprise-Id / X-Tenant-Id for a team account (none for a personal one). */
export function enterpriseHeaders(a: WorkBuddyAccount): Record<string, string> {
  return a.enterpriseId ? { 'X-Enterprise-Id': a.enterpriseId, 'X-Tenant-Id': a.enterpriseId } : {};
}

/** The headers WorkBuddy's API takes a request with (10085 for any other User-Agent). */
export function signHeaders(a: WorkBuddyAccount): Record<string, string> {
  return {
    Authorization: `Bearer ${a.access}`,
    'X-User-Id': a.uid,
    'X-Domain': workbuddyDomain(a),
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'User-Agent': `WorkBuddy/${WORKBUDDY_UA_VERSION}`,
    'X-Requested-With': 'XMLHttpRequest',
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': WORKBUDDY_UA_VERSION,
    ...enterpriseHeaders(a),
  };
}

export interface WorkBuddyAuthDeps {
  fetchImpl: ProxyFetch;
  read?: () => WorkBuddyAccount | null;
  now?: () => number;
}

/** A source of a fresh WorkBuddy account (renewed in memory when about to end). */
export function createWorkBuddyAuth(deps: WorkBuddyAuthDeps): { current(signal?: AbortSignal): Promise<WorkBuddyAccount | null> } {
  const read = deps.read ?? (() => readWorkBuddyDesktop());
  const now = deps.now ?? Date.now;
  const held = new Map<string, WorkBuddyAccount>();
  const renewing = new Map<string, Promise<WorkBuddyAccount | null>>();

  async function renew(a: WorkBuddyAccount, signal?: AbortSignal): Promise<WorkBuddyAccount | null> {
    let res;
    try {
      res = await deps.fetchImpl(`${WORKBUDDY_ENDPOINT}/v2/plugin/auth/token/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': `WorkBuddy/${WORKBUDDY_UA_VERSION}`,
          'X-Refresh-Token': a.refresh,
          'X-Auth-Refresh-Source': 'plugin',
          'X-Domain': workbuddyDomain(a),
          ...enterpriseHeaders(a),
        },
        body: '{}',
        signal,
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    let env: { code?: unknown; data?: Record<string, unknown> };
    try {
      env = JSON.parse(await res.text()) as typeof env;
    } catch {
      return null;
    }
    const got = env.code ? undefined : env.data;
    const access = s(got?.accessToken);
    if (!got || !access) return null;
    const t = now();
    return {
      ...a,
      access,
      refresh: s(got.refreshToken) || a.refresh,
      domain: s(got.domain) || a.domain,
      expires: n(got.expiresAt) || (n(got.expiresIn) ? t + n(got.expiresIn) * 1000 : a.expires),
      refreshExpiresAt: n(got.refreshExpiresAt) || (n(got.refreshExpiresIn) ? t + n(got.refreshExpiresIn) * 1000 : a.refreshExpiresAt),
    };
  }

  return {
    async current(signal) {
      const d = read();
      if (!d) return null;
      const h = held.get(d.uid);
      const a = h && h.expires >= d.expires ? h : d;
      const t = now();
      const stale = a.expires > 0 && t >= a.expires - EARLY_MS;
      const refreshable = !!a.refresh && !(a.refreshExpiresAt && t >= a.refreshExpiresAt);
      if (!stale || !refreshable) return a;
      let p = renewing.get(a.refresh);
      if (!p) {
        p = renew(a, signal).finally(() => renewing.delete(a.refresh));
        renewing.set(a.refresh, p);
      }
      const next = await p;
      if (!next) return a; // a failed renewal leaves the token there is
      held.set(d.uid, next);
      return next;
    },
  };
}
