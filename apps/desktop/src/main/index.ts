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

app.whenReady().then(() => {
  installSessionSecurity();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });

  logger.info('app.ready');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
