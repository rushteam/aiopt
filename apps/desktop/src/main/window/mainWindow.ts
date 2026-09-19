// The main application window. Every security-relevant BrowserWindow option is
// set EXPLICITLY here — we never rely on Electron defaults. See
// docs/dev-rules/electron-security-and-process-boundaries.md §3.

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNavigationGuards } from '../security/navigation';
import { APP_PROTOCOL } from '../appProtocol';
import { isQuitting } from '../tray/tray';
import { logger } from '../logger';

const log = logger.child('window');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createMainWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1024,
    height: 720,
    show: false,
    // Chrome: on macOS hide the native title bar but keep the (inset) traffic-light
    // controls, so app content reaches the top edge — the renderer supplies a
    // draggable strip (see App's TitleBar). Elsewhere we keep the native frame for
    // now; a custom cross-platform title bar with its own min/max/close controls is
    // separate work. None of this touches the §3 hardening options below.
    ...(isMac ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 16 } } : {}),
    webPreferences: {
      // Preload is emitted next to the main bundle by plugin-vite.
      preload: path.join(__dirname, 'preload.js'),
      // Hardening — do not loosen any of these (§3).
      // DevTools is a development-only affordance: disabled entirely in packaged
      // builds so end users can't open it (via menu, accelerator, programmatic
      // openDevTools, or any built-in shortcut). The View menu also drops the
      // DevTools/reload items in packaged builds (see menu/viewMenu.ts); this is
      // the hard backstop behind that.
      devTools: !app.isPackaged,
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

  // Closing the window hides it to the menu-bar Tray instead of destroying it, so the
  // app keeps running (macOS convention). A real quit (⌘Q / menu / Tray Quit) sets the
  // quit flag first (before-quit), so this guard lets the window close for good then.
  win.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault();
      win.hide();
      log.info('window.hidden');
    }
  });

  return win;
}
