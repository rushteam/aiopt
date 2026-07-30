// Navigation & external-link guards — fail closed.
//
// The renderer must never navigate the app frame off its own origin, never spawn
// a real popup window, and never hand an arbitrary URL to the system shell. Main
// enforces all three; the renderer cannot loosen them. See
// docs/dev-rules/electron-security-and-process-boundaries.md §6.

import { shell } from 'electron';
import type { WebContents } from 'electron';
import { logger } from '../logger';

const log = logger.child('navigation');

// The only protocols an external link may use. A custom scheme (e.g. opening
// system settings) would need its own static, exact allowlist — not this.
const EXTERNAL_PROTOCOL_ALLOWLIST = new Set(['http:', 'https:']);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Is `target` a navigation the app frame is allowed to perform in-place? Only
 * same-origin navigation to the app's own origin is allowed. Everything else is
 * refused (and, if it's an external link, opened in the system browser instead).
 *
 * Pure and Electron-free for direct unit testing.
 */
export function isAllowedInAppNavigation(target: string, appOrigin: string): boolean {
  const url = parseUrl(target);
  if (!url) return false;
  const origin = parseUrl(appOrigin);
  if (!origin) return false;
  return url.origin === origin.origin;
}

/**
 * Is `target` a URL we're willing to hand to the system browser? Must parse and
 * use an allowlisted protocol. Pure and Electron-free.
 */
export function isAllowedExternalUrl(target: string): boolean {
  const url = parseUrl(target);
  if (!url) return false;
  return EXTERNAL_PROTOCOL_ALLOWLIST.has(url.protocol);
}

/** Open a URL in the system browser iff it passes the external allowlist. */
export async function openExternalUrl(target: string): Promise<boolean> {
  if (!isAllowedExternalUrl(target)) {
    log.warn('external.refused', { protocol: parseUrl(target)?.protocol ?? 'unparseable' });
    return false;
  }
  await shell.openExternal(target);
  return true;
}

/**
 * Wire the fail-closed guards onto a WebContents:
 *  - `will-navigate`: cancel any navigation off the app origin.
 *  - `setWindowOpenHandler`: deny every popup; route allowlisted links to the
 *    system browser instead.
 */
export function installNavigationGuards(contents: WebContents, appOrigin: string): void {
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedInAppNavigation(url, appOrigin)) {
      event.preventDefault();
      log.warn('navigation.refused', { origin: parseUrl(url)?.origin ?? 'unparseable' });
      void openExternalUrl(url);
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    // Never let the renderer open a real Electron window.
    return { action: 'deny' };
  });
}
