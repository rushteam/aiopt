// Main process entry — app lifecycle only. Security wiring lives in
// bootstrap-electron.ts; the window is built in window/mainWindow.ts.

import { app, BrowserWindow, dialog } from 'electron';
import started from 'electron-squirrel-startup';
import {
  acquireSingleInstanceLock,
  installSessionSecurity,
  isolateDevUserData,
  registerPrivilegedSchemes,
} from './bootstrap-electron';
import { createMainWindow } from './window/mainWindow';
import { registerHandlers } from './ipc/registerHandlers';
import { installAppMenu } from './menu/appMenu';
import { installTray, markQuitting } from './tray/tray';
import { getConfigStore, getProviderManager, getTranslationProxy } from './services';
import {
  QUIT_DIALOG_LABELS,
  formatQuitMessage,
  resolveQuitDialogLocale,
  shouldWarnBeforeQuit,
} from './app/quitGuard';
import { logger } from './logger';

// Before anything touches userData — the single-instance lock below included.
isolateDevUserData();

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

// Set once the quit is confirmed (or never needed a warning), so the re-entrant
// `app.quit()` after the async dialog passes straight through this handler.
let quitConfirmed = false;

/**
 * Warn before a REAL quit while proxied bindings are live: quitting stops the loopback
 * proxy, so every proxied agent can't connect until AiOpt runs again. Covers ⌘Q, the
 * native menu Quit, the Tray Quit, and the in-app menu's Quit — they all funnel through
 * before-quit. The dialog only INFORMS; it never rewrites a config or writes a key.
 */
async function confirmQuitDespiteProxy(proxiedCount: number): Promise<void> {
  const config = getConfigStore();
  const pref = config.get('language');
  const locale = resolveQuitDialogLocale(pref === 'system' ? app.getLocale() : pref);
  const labels = QUIT_DIALOG_LABELS[locale];
  const win = BrowserWindow.getAllWindows()[0];
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: [labels.confirm, labels.cancel],
    defaultId: 0,
    cancelId: 1,
    title: labels.title,
    message: formatQuitMessage(labels, proxiedCount),
    detail: labels.detail,
    checkboxLabel: labels.dontAskAgain,
    checkboxChecked: false,
  };
  const { response, checkboxChecked } =
    win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts);

  if (response !== 0) return; // Cancelled: stay running (in the tray on macOS).
  if (checkboxChecked) config.set('warnOnQuitWithProxy', false);
  quitConfirmed = true;
  app.quit();
}

// macOS keeps the app alive on window-all-closed, so the proxy rightly outlives closed
// windows; it stops only on a real quit. When proxied routes are live we first confirm
// (see confirmQuitDespiteProxy) — that path re-issues quit with quitConfirmed set.
app.on('before-quit', (event) => {
  // The early squirrel/single-instance quits fire before `ready`; never intercept
  // those (services aren't built yet, and there's nothing proxied to warn about).
  if (app.isReady() && !quitConfirmed) {
    // Decide synchronously. Cancelling a quit that needs no warning and re-issuing it
    // from inside this handler is swallowed by Electron (the second before-quit runs,
    // but the app never reaches will-quit), so the user had to quit twice.
    const proxiedCount = getProviderManager()
      .getSnapshot()
      .agents.filter((a) => a.proxied).length;
    if (shouldWarnBeforeQuit(getConfigStore().get('warnOnQuitWithProxy'), proxiedCount)) {
      event.preventDefault();
      void confirmQuitDespiteProxy(proxiedCount);
      return;
    }
  }
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
