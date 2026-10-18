// CodeArts browser OAuth (portal + STS PKCE/DPoP). Main-only; loopback on 127.0.0.1.

import http from 'node:http';
import {
  CODEARTS_CLIENT_ID,
  CODEARTS_MIN_CALLBACK_PORT,
  CODEARTS_OAUTH_TIMEOUT_MS,
  CODEARTS_PLUGIN_NAME,
  CODEARTS_PLUGIN_VERSION,
  CODEARTS_PORTAL_AUTHORIZE,
  CODEARTS_PORTAL_LOGIN,
  CODEARTS_REDIRECT_PATH,
  CODEARTS_STS_TOKEN_URL,
} from './constants';
import {
  dpopKeyPairFromPrivateJwk,
  generateCodeArtsDpopKeyPair,
  generateCodeArtsPkce,
  signCodeArtsDpop,
  type CodeArtsDpopKeyPair,
  type CodeArtsPkcePair,
} from './dpop';
import { randomHex } from './sign';
import {
  serializeCodeArtsSession,
  sessionAccountLabel,
  sessionExpiresAtMs,
  sessionFromTokenResponse,
  type CodeArtsSession,
} from './session';

export type CodeArtsLoginFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CodeArtsLoginResult {
  session: CodeArtsSession;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
  accountLabel?: string;
}

function portalLoginResultUrl(ok: boolean): string {
  return `${CODEARTS_PORTAL_LOGIN}?login_succeed=${ok ? 'true' : 'false'}&uri_scheme=${CODEARTS_CLIENT_ID}&locale=zh-cn`;
}

export function buildCodeArtsAuthorizeUrl(
  port: number,
  pkce: CodeArtsPkcePair,
  ticketId: string,
): string {
  const u = new URL(CODEARTS_PORTAL_AUTHORIZE);
  u.searchParams.set('theme', '2');
  u.searchParams.set('locale', 'zh-cn');
  u.searchParams.set('uri_scheme', CODEARTS_CLIENT_ID);
  u.searchParams.set('client_id', CODEARTS_CLIENT_ID);
  u.searchParams.set('port', String(port));
  u.searchParams.set('code_challenge', pkce.challenge);
  // Portal expects this spelling (not the RFC S256 token).
  u.searchParams.set('code_challenge_method', 'SHA-256');
  u.searchParams.set('ticket_id', ticketId);
  u.searchParams.set('plugin-name', CODEARTS_PLUGIN_NAME);
  u.searchParams.set('plugin-version', CODEARTS_PLUGIN_VERSION);
  return u.toString();
}

async function requestStsToken(
  body: Record<string, string>,
  keyPair: CodeArtsDpopKeyPair,
  fetchImpl: CodeArtsLoginFetch,
): Promise<unknown> {
  const dpop = await signCodeArtsDpop(keyPair, 'POST', CODEARTS_STS_TOKEN_URL);
  const response = await fetchImpl(CODEARTS_STS_TOKEN_URL, {
    method: 'POST',
    headers: {
      DPoP: dpop,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body).toString(),
  });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || !data || typeof data !== 'object' || !('credentials' in (data as object))) {
    const err = new Error('CodeArts STS token request failed');
    (err as Error & { status?: number }).status = response.status;
    throw err;
  }
  return data;
}

export async function exchangeCodeArtsAuthorizationCode(
  code: string,
  codeVerifier: string,
  port: number,
  keyPair: CodeArtsDpopKeyPair,
  fetchImpl: CodeArtsLoginFetch,
): Promise<CodeArtsSession> {
  const token = await requestStsToken(
    {
      client_id: CODEARTS_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: `http://127.0.0.1:${port}${CODEARTS_REDIRECT_PATH}`,
    },
    keyPair,
    fetchImpl,
  );
  const session = sessionFromTokenResponse(token, codeVerifier, keyPair.privateKeyJwk);
  if (!session) throw new Error('CodeArts STS response missing credentials');
  return session;
}

export async function refreshCodeArtsSession(
  session: CodeArtsSession,
  fetchImpl: CodeArtsLoginFetch,
): Promise<CodeArtsSession> {
  if (!session.refreshToken || !session.codeVerifier || !session.dpopPrivateKeyJwk.d) {
    throw new Error('CodeArts session cannot be refreshed');
  }
  const keyPair = dpopKeyPairFromPrivateJwk(session.dpopPrivateKeyJwk);
  const token = await requestStsToken(
    {
      client_id: CODEARTS_CLIENT_ID,
      code_verifier: session.codeVerifier,
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    },
    keyPair,
    fetchImpl,
  );
  const next = sessionFromTokenResponse(token, session.codeVerifier, keyPair.privateKeyJwk);
  if (!next) throw new Error('CodeArts refresh response missing credentials');
  if (!next.refreshToken) next.refreshToken = session.refreshToken;
  if (session.userName && !next.userName) next.userName = session.userName;
  if (session.userId && !next.userId) next.userId = session.userId;
  if (session.domainId && !next.domainId) next.domainId = session.domainId;
  return next;
}

function listenCodeArtsPort(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number): void => {
      const onErr = (err: Error): void => {
        server.off('error', onErr);
        reject(err);
      };
      server.once('error', onErr);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onErr);
        const addr = server.address();
        const assigned = typeof addr === 'object' && addr ? addr.port : 0;
        if (assigned >= CODEARTS_MIN_CALLBACK_PORT) {
          resolve(assigned);
          return;
        }
        server.close(() => {
          const next =
            Math.floor(Math.random() * (65_536 - CODEARTS_MIN_CALLBACK_PORT)) +
            CODEARTS_MIN_CALLBACK_PORT;
          tryListen(next);
        });
      });
    };
    tryListen(0);
  });
}

/**
 * Full browser login: loopback callback → portal → STS. Caller opens `authorizeUrl`
 * and awaits `result`. Always call `close()` when done.
 */
export async function startCodeArtsOAuthFlow(fetchImpl: CodeArtsLoginFetch): Promise<{
  authorizeUrl: string;
  result: Promise<CodeArtsLoginResult>;
  close: () => void;
}> {
  const ticketId = randomHex(16);
  const pkce = await generateCodeArtsPkce();
  const keyPair = await generateCodeArtsDpopKeyPair();

  let settled = false;
  let resolveResult!: (value: CodeArtsLoginResult) => void;
  let rejectResult!: (err: Error) => void;
  const result = new Promise<CodeArtsLoginResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== CODEARTS_REDIRECT_PATH) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const finish = (session: CodeArtsSession): void => {
      if (settled) return;
      settled = true;
      const accessToken = serializeCodeArtsSession(session);
      resolveResult({
        session,
        accessToken,
        refreshToken: session.refreshToken,
        expiresAt: sessionExpiresAtMs(session),
        accountLabel: sessionAccountLabel(session),
      });
    };

    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(307, { Location: portalLoginResultUrl(false) });
      res.end();
      if (!settled) {
        settled = true;
        rejectResult(new Error('CodeArts OAuth callback missing code'));
      }
      return;
    }

    const port = (() => {
      const addr = server.address();
      return typeof addr === 'object' && addr ? addr.port : 0;
    })();

    void exchangeCodeArtsAuthorizationCode(code, pkce.verifier, port, keyPair, fetchImpl).then(
      (session) => {
        res.writeHead(307, { Location: portalLoginResultUrl(true) });
        res.end();
        finish(session);
      },
      (err: unknown) => {
        res.writeHead(307, { Location: portalLoginResultUrl(false) });
        res.end();
        if (!settled) {
          settled = true;
          rejectResult(err instanceof Error ? err : new Error(String(err)));
        }
      },
    );
  });

  const port = await listenCodeArtsPort(server);
  const authorizeUrl = buildCodeArtsAuthorizeUrl(port, pkce, ticketId);

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectResult(new Error('CodeArts OAuth login timed out'));
    }
  }, CODEARTS_OAUTH_TIMEOUT_MS);
  timer.unref?.();

  const close = (): void => {
    clearTimeout(timer);
    server.close();
  };

  return { authorizeUrl, result, close };
}
