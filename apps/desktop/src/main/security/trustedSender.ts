// Trusted-sender gate — the IPC authorization boundary.
//
// A privileged IPC may only be called by the app's OWN top-level renderer frame.
// Sub-frames, popups, and any frame navigated off the app origin fail closed.
// Identity is taken ONLY from the Electron-held sender / senderFrame — never from
// a field the renderer reports about itself. See the security rule §5.

import type { IpcMainInvokeEvent } from 'electron';
import { throwIpcError } from '../ipc/validate';

export interface TrustedRendererLocation {
  /** The Vite dev-server URL when running `dev`, else null. */
  devServerUrl: string | null;
  /** The exact URL the packaged renderer is loaded from. */
  packagedAppUrl: string;
}

// Minimal structural shape of the parts of an IpcMainInvokeEvent we trust. The
// pure predicate below takes this so it can be unit-tested without Electron.
export interface TrustedSenderFrameLike {
  url: string;
  parent: TrustedSenderFrameLike | null;
}
export interface TrustedSenderEventLike {
  senderFrame: TrustedSenderFrameLike | null;
  senderMainFrame: TrustedSenderFrameLike | null;
}

/** Pure URL check for the two allowed renderer locations. Electron-free. */
export function isTrustedAppRendererUrl(rawUrl: string, loc: TrustedRendererLocation): boolean {
  let actual: URL;
  try {
    actual = new URL(rawUrl);
  } catch {
    return false;
  }
  if (loc.devServerUrl) {
    let expected: URL;
    try {
      expected = new URL(loc.devServerUrl);
    } catch {
      return false;
    }
    if (!['http:', 'https:'].includes(expected.protocol)) return false;
    return actual.origin === expected.origin;
  }
  // Packaged: the renderer is served from a custom protocol URL. Compare the
  // normalized full location, not just the origin.
  try {
    return actual.href === new URL(loc.packagedAppUrl).href;
  } catch {
    return false;
  }
}

/**
 * Pure trusted-sender predicate. The frame must be present, BE the top-level main
 * frame (not a sub-frame, `parent === null`), and sit at an allowed URL.
 */
export function isTrustedAppRendererEventForLocation(
  event: TrustedSenderEventLike,
  loc: TrustedRendererLocation,
): boolean {
  const frame = event.senderFrame;
  if (!frame || frame !== event.senderMainFrame || frame.parent !== null) return false;
  return isTrustedAppRendererUrl(frame.url, loc);
}

function currentLocation(): TrustedRendererLocation {
  return {
    devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL || null,
    // Kept in sync with window/mainWindow.ts packaged load URL.
    packagedAppUrl: 'aiopt://main/index.html',
  };
}

/** Production check against a real Electron invoke event. */
export function isTrustedAppRendererEvent(event: IpcMainInvokeEvent): boolean {
  return isTrustedAppRendererEventForLocation(
    {
      senderFrame: event.senderFrame as unknown as TrustedSenderFrameLike | null,
      senderMainFrame: event.sender.mainFrame as unknown as TrustedSenderFrameLike | null,
    },
    currentLocation(),
  );
}

/** Assert a privileged IPC came from the trusted renderer; never leak the allowed URL. */
export function assertTrustedAppRendererEvent(event: IpcMainInvokeEvent): void {
  if (!isTrustedAppRendererEvent(event)) {
    throwIpcError('PERMISSION_DENIED', 'operation is only allowed from the app window');
  }
}
