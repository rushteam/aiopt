// Content-Security-Policy — injected in ONE place, on the main side, via
// session.webRequest.onHeadersReceived. Do not register a second listener that
// would override this. See docs/dev-rules/electron-security-and-process-boundaries.md §7.
//
// Production `script-src` is `'self'` with NO exceptions — no remote scripts, no
// 'unsafe-inline', no 'unsafe-eval'. Widening any directive is a security review,
// not a casual edit.

import type { Session } from 'electron';
import { logger } from '../logger';

const log = logger.child('csp');

/**
 * Build the CSP header value.
 *
 * `dev` relaxes exactly what the Vite dev server needs (an inline bootstrap and a
 * websocket back to the dev server) and nothing more. `prod` is locked down.
 *
 * Pure and Electron-free so it can be unit-tested directly.
 */
export function buildCspHeaderValue(isDev: boolean): string {
  const scriptSrc = ["'self'"];
  const styleSrc = ["'self'"];
  const connectSrc = ["'self'"];

  if (isDev) {
    // Vite injects styles and an HMR client at runtime and talks to the dev
    // server over ws/http. These relaxations MUST NOT reach production.
    scriptSrc.push("'unsafe-inline'");
    styleSrc.push("'unsafe-inline'");
    connectSrc.push('ws:', 'http://localhost:*');
  }

  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', scriptSrc],
    ['style-src', styleSrc],
    ['img-src', ["'self'", 'data:']],
    ['font-src', ["'self'"]],
    ['connect-src', connectSrc],
    ['object-src', ["'none'"]],
    ['frame-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ];

  return directives.map(([key, values]) => `${key} ${values.join(' ')}`).join('; ');
}

/**
 * Install the CSP header on a session. Single choke point — call this once per
 * session that renders app content.
 */
export function installCsp(session: Session, isDev: boolean): void {
  const headerValue = buildCspHeaderValue(isDev);
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [headerValue],
      },
    });
  });
  log.info('csp.installed', { isDev });
}
