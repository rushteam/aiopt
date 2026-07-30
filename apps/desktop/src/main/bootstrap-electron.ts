// Electron bootstrap: privileged-scheme registration (must run before app ready)
// and the packaged-asset protocol handler + CSP (after ready). Fuses are applied
// at package time by FusesPlugin in forge.config.ts, not here.

import { app, net, protocol, session } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_PROTOCOL } from './appProtocol';
import { installCsp } from './security/csp';
import { logger } from './logger';

const log = logger.child('bootstrap');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const isDev = Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL);

/**
 * Register the app's custom scheme as privileged. MUST be called before the app
 * `ready` event. `standard` + `secure` make it a proper web origin so the
 * renderer's same-origin policy and our CSP apply normally.
 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

/**
 * Serve packaged renderer assets over the custom protocol, with a path-traversal
 * guard so a crafted URL can never escape the renderer output directory. In dev
 * the renderer is loaded from the Vite dev server instead, so this is a no-op.
 */
function registerAppProtocol(): void {
  if (isDev) return;
  const rendererRoot = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);

  protocol.handle(APP_PROTOCOL, async (request) => {
    const url = new URL(request.url);
    // Strip the leading slash and normalize; default to index.html.
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const resolved = path.normalize(path.join(rendererRoot, relative));

    // Fail closed on traversal outside the renderer root.
    if (resolved !== rendererRoot && !resolved.startsWith(rendererRoot + path.sep)) {
      log.warn('protocol.traversal_blocked');
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });
}

/** Post-`ready` wiring: CSP choke point + packaged-asset protocol. */
export function installSessionSecurity(): void {
  installCsp(session.defaultSession, isDev);
  registerAppProtocol();
  log.info('session.security_installed', { isDev });
}

/** Ensure a single running instance; returns false if another instance owns the lock. */
export function acquireSingleInstanceLock(): boolean {
  return app.requestSingleInstanceLock();
}
