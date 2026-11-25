import http from 'node:http';
import { logger } from '../logger';

const log = logger.child('oauth.callback');

const FLOW_TIMEOUT_MS = 120_000;

export interface OAuthCallbackResult {
  code: string | null;
  error: string | null;
  state: string | null;
}

export interface OAuthCallbackServerOptions {
  /** Fixed port a vendor's registered redirect URI requires; default 0 (ephemeral). */
  port?: number;
  /** Redirect path (default `/callback`). */
  path?: string;
  /** Host written into the redirect URI (default `127.0.0.1`); the bind is always 127.0.0.1. */
  redirectHost?: string;
  /** How long to wait for the browser (default 120 s). */
  timeoutMs?: number;
}

/**
 * Ephemeral loopback listener for OAuth redirects. Binds `127.0.0.1` only.
 */
export function startOAuthCallbackServer(opts: OAuthCallbackServerOptions = {}): Promise<{
  redirectUri: string;
  port: number;
  result: Promise<OAuthCallbackResult>;
  close: () => void;
}> {
  const callbackPath = opts.path ?? '/callback';
  return new Promise((resolve, reject) => {
    let settled = false;
    let resolveResult!: (value: OAuthCallbackResult) => void;
    const result = new Promise<OAuthCallbackResult>((res) => {
      resolveResult = res;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== callbackPath) {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const state = url.searchParams.get('state');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<html><body><p>Login complete. You can close this tab and return to AiOpt.</p></body></html>',
      );
      if (!settled) {
        settled = true;
        resolveResult({ code, error, state });
      }
    });

    server.on('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const redirectUri = `http://${opts.redirectHost ?? '127.0.0.1'}:${port}${callbackPath}`;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          log.info('oauth.callback_timeout');
          resolveResult({ code: null, error: 'timeout', state: null });
        }
      }, opts.timeoutMs ?? FLOW_TIMEOUT_MS);

      const close = (): void => {
        clearTimeout(timer);
        server.close();
      };

      resolve({ redirectUri, port, result, close });
    });
  });
}
