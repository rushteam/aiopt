// The main application window. Every security-relevant BrowserWindow option is
// set EXPLICITLY here — we never rely on Electron defaults. See
// docs/dev-rules/electron-security-and-process-boundaries.md §3.

import { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNavigationGuards } from '../security/navigation';
import { APP_PROTOCOL } from '../appProtocol';
import { logger } from '../logger';

const log = logger.child('window');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1024,
    height: 720,
    show: false,
    webPreferences: {
      // Preload is emitted next to the main bundle by plugin-vite.
      preload: path.join(__dirname, 'preload.js'),
      // Hardening — do not loosen any of these (§3).
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
    },
  });

  // Determine the app origin the renderer is allowed to stay within, then wire
  // the fail-closed navigation guards before loading anything.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    installNavigationGuards(win.webContents, new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin);
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    // Packaged: renderer is served from the custom app protocol (see
    // bootstrap-electron.ts). Origin is the protocol scheme's own origin.
    const appUrl = `${APP_PROTOCOL}://main/index.html`;
    installNavigationGuards(win.webContents, new URL(appUrl).origin);
    void win.loadURL(appUrl);
  }

  win.once('ready-to-show', () => {
    win.show();
    log.info('window.shown');
  });

  return win;
}
