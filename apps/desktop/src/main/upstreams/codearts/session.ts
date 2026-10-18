// CodeArts OAuth session shape — stored as JSON inside the oauth token
// bundle's `accessToken` field (see oauth-providers.md credential split).
// Pure parse/serialize; no I/O.

export interface CodeArtsDpopJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d?: string;
}

/** Temporary STS credentials + material needed to refresh. */
export interface CodeArtsSession {
  accessKeyId: string;
  secretAccessKey: string;
  securityToken: string;
  /** ISO-8601 expiry from STS, when present. */
  expiresAt: string;
  refreshToken?: string;
  codeVerifier: string;
  dpopPrivateKeyJwk: CodeArtsDpopJwk;
  userName?: string;
  userId?: string;
  domainId?: string;
}

function s(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function asJwk(raw: unknown): CodeArtsDpopJwk | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.kty !== 'EC' || o.crv !== 'P-256') return null;
  const x = s(o.x);
  const y = s(o.y);
  const d = s(o.d);
  if (!x || !y || !d) return null;
  return { kty: 'EC', crv: 'P-256', x, y, d };
}

/** Parse a session from the oauth bundle access field (JSON string). */
export function parseCodeArtsSession(raw: string | null | undefined): CodeArtsSession | null {
  if (!raw || raw.trim() === '') return null;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const o = doc as Record<string, unknown>;
  const accessKeyId = s(o.accessKeyId) || s(o.access_key_id);
  const secretAccessKey = s(o.secretAccessKey) || s(o.secret_access_key);
  const securityToken = s(o.securityToken) || s(o.security_token);
  const codeVerifier = s(o.codeVerifier) || s(o.code_verifier);
  const jwk = asJwk(o.dpopPrivateKeyJwk ?? o.dpop_private_key_jwk);
  if (!accessKeyId || !secretAccessKey || !securityToken || !codeVerifier || !jwk) return null;
  const expiresAt = s(o.expiresAt) || s(o.expires_at);
  const refreshToken = s(o.refreshToken) || s(o.refresh_token) || undefined;
  const userName = s(o.userName) || s(o.user_name) || undefined;
  const userId = s(o.userId) || s(o.user_id) || undefined;
  const domainId = s(o.domainId) || s(o.domain_id) || undefined;
  return {
    accessKeyId,
    secretAccessKey,
    securityToken,
    expiresAt,
    codeVerifier,
    dpopPrivateKeyJwk: jwk,
    ...(refreshToken ? { refreshToken } : {}),
    ...(userName ? { userName } : {}),
    ...(userId ? { userId } : {}),
    ...(domainId ? { domainId } : {}),
  };
}

export function serializeCodeArtsSession(session: CodeArtsSession): string {
  return JSON.stringify({
    accessKeyId: session.accessKeyId,
    secretAccessKey: session.secretAccessKey,
    securityToken: session.securityToken,
    expiresAt: session.expiresAt,
    refreshToken: session.refreshToken,
    codeVerifier: session.codeVerifier,
    dpopPrivateKeyJwk: session.dpopPrivateKeyJwk,
    userName: session.userName,
    userId: session.userId,
    domainId: session.domainId,
  });
}

export function sessionExpiresAtMs(session: CodeArtsSession): number | null {
  if (!session.expiresAt) return null;
  const ms = Date.parse(session.expiresAt);
  return Number.isFinite(ms) ? ms : null;
}

export function sessionAccountLabel(session: CodeArtsSession): string | undefined {
  return session.userName || session.userId || undefined;
}

/** Build a session from an STS token JSON body + PKCE/DPoP material. */
export function sessionFromTokenResponse(
  token: unknown,
  codeVerifier: string,
  dpopPrivateKeyJwk: CodeArtsDpopJwk,
): CodeArtsSession | null {
  if (!token || typeof token !== 'object') return null;
  const o = token as Record<string, unknown>;
  const cred = (o.credentials && typeof o.credentials === 'object'
    ? o.credentials
    : null) as Record<string, unknown> | null;
  if (!cred) return null;
  const accessKeyId = s(cred.access_key_id);
  const secretAccessKey = s(cred.secret_access_key);
  const securityToken = s(cred.security_token);
  if (!accessKeyId || !secretAccessKey || !securityToken) return null;
  const refreshToken = s(o.refresh_token) || undefined;
  return {
    accessKeyId,
    secretAccessKey,
    securityToken,
    expiresAt: s(cred.expiration),
    codeVerifier,
    dpopPrivateKeyJwk,
    ...(refreshToken ? { refreshToken } : {}),
  };
}
