// Main process entry — app lifecycle only. Security wiring lives in
// bootstrap-electron.ts; the window is built in window/mainWindow.ts.

import { app, BrowserWindow } from 'electron';
import started from 'electron-squirrel-startup';
import {
  acquireSingleInstanceLock,
  installSessionSecurity,
  registerPrivilegedSchemes,
} from './bootstrap-electron';
import { createMainWindow } from './window/mainWindow';
import { registerHandlers } from './ipc/registerHandlers';
import { installAppMenu } from './menu/appMenu';
import { installTray, markQuitting } from './tray/tray';
import { getProviderManager, getTranslationProxy } from './services';
import { logger } from './logger';

// Windows Squirrel first-run shortcut handling; quits early during install.
if (started) {
  app.quit();
}

if (!acquireSingleInstanceLock()) {
  app.quit();
}

// Must run before `ready`.
registerPrivilegedSchemes();

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  installSessionSecurity();
  // Handlers must be registered before the window loads so the renderer's first
  // calls always find one.
  registerHandlers();

  // Start the cross-format translation proxy and refresh routes for any cross-format
  // bindings from a previous session (the port is ephemeral and tokens rotate, so the
  // baseUrl+token written to disk last time now point at a dead listener). A failure
  // here must never crash the app — same-format bindings work without the proxy.
  try {
    await getTranslationProxy().start();
    getProviderManager().rebuildProxyRoutes();
  } catch (err) {
    logger.error('proxy.start_failed', { message: err instanceof Error ? err.message : String(err) });
  }

  // Native menu dispatches commands to the renderer, so install it before the
  // window loads.
  installAppMenu();
  createMainWindow();
  // macOS menu-bar icon. Must be created after `ready`. Adds no IPC/renderer
  // privilege — it reuses the menu-command path and a main-side window reveal.
  installTray();

  app.on('activate', () => {
    // Recreate the window if it was fully closed, otherwise reveal the hidden one
    // (close hides to the tray rather than destroying — see window/mainWindow.ts).
    const [win] = BrowserWindow.getAllWindows();
    if (!win || win.isDestroyed()) {
      createMainWindow();
    } else {
      win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  logger.info('app.ready');
});

// Stop the loopback proxy on quit (this repo's first before-quit handler). macOS keeps
// the app alive on window-all-closed, so the server rightly outlives closed windows.
app.on('before-quit', () => {
  // From here on the window close handler must let the window close (not hide to tray).
  markQuitting();
  void getTranslationProxy()
    .stop()
    .catch((err) => logger.error('proxy.stop_failed', { message: err instanceof Error ? err.message : String(err) }));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
