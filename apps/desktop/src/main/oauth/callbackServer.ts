import http from 'node:http';
import { logger } from '../logger';

const log = logger.child('oauth.callback');

const FLOW_TIMEOUT_MS = 120_000;

export interface OAuthCallbackResult {
  code: string | null;
  error: string | null;
  state: string | null;
}

/**
 * Ephemeral loopback listener for OAuth redirects. Binds `127.0.0.1` only.
 */
export function startOAuthCallbackServer(): Promise<{
  redirectUri: string;
  port: number;
  result: Promise<OAuthCallbackResult>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let resolveResult!: (value: OAuthCallbackResult) => void;
    const result = new Promise<OAuthCallbackResult>((res) => {
      resolveResult = res;
    });

    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
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
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/callback`;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          log.info('oauth.callback_timeout');
          resolveResult({ code: null, error: 'timeout', state: null });
        }
      }, FLOW_TIMEOUT_MS);

      const close = (): void => {
        clearTimeout(timer);
        server.close();
      };

      resolve({ redirectUri, port, result, close });
    });
  });
}
