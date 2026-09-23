// The macOS menu-bar (Tray) icon and its context menu.
//
// The Tray lives ENTIRELY in the main process. It adds no IPC channel, no preload
// method, and no renderer privilege: its command items reuse the exact one-way
// `MenuCommand` path the native app menu uses (see menu/dispatchToRenderer.ts), and
// "Show window" is a pure main-side reveal that never touches the renderer. So the
// Tray widens no authorization surface — it is a second trigger for capabilities the
// app already exposes through the menu.
//
// Behaviour (product decisions):
//   - Clicking the Tray icon pops the context menu (macOS does this once a context
//     menu is set; we don't bind a click-to-toggle).
//   - Closing the window HIDES it instead of quitting (see window/mainWindow.ts,
//     which checks `isQuitting()`), so the app keeps running in the menu bar. Real
//     quit — ⌘Q, the menu's Quit, or this Tray's Quit — sets the quit flag via
//     before-quit and lets the window close for good.

import { app, Menu, Tray, nativeImage, BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { MENU_COMMANDS, type MenuCommand } from '../../shared/menuCommands';
import { MENU_LABELS, resolveMenuLocaleForPreference, type MenuLabels } from '../menu/menuLabels';
import { dispatchToRenderer } from '../menu/dispatchToRenderer';
import { createMainWindow } from '../window/mainWindow';
import { TRAY_ICON_16, TRAY_ICON_32 } from './trayIconData';
import { getConfigStore } from '../services';
import { logger } from '../logger';

const log = logger.child('tray');

// Distinguish a user-initiated quit (⌘Q / menu Quit / Tray Quit) from the window's
// close button. Only the former should let the window actually close; the latter
// hides to the tray. Lives here (not in index/window) so window/mainWindow.ts can
// import the flag without a cycle back through the lifecycle entry point.
let quitting = false;

/** True once a real quit is under way (set in the app's before-quit handler). */
export function isQuitting(): boolean {
  return quitting;
}

/** Mark that the app is genuinely quitting, so window close is no longer intercepted. */
export function markQuitting(): void {
  quitting = true;
}

/** Reveal and focus the main window, recreating it if it was fully closed. */
function showMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) {
    createMainWindow();
    return;
  }
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

/** A tray command item: reveal the window first (commands target a live renderer), then dispatch. */
function commandItem(label: string, command: MenuCommand): MenuItemConstructorOptions {
  return {
    label,
    click: () => {
      showMainWindow();
      dispatchToRenderer(command);
    },
  };
}

/** Build the menu-bar template image (monochrome; the OS tints it per light/dark bar). */
function buildTrayImage(): Electron.NativeImage {
  const img = nativeImage.createFromDataURL(TRAY_ICON_16);
  img.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_32 });
  img.setTemplateImage(true);
  return img;
}

let tray: Tray | null = null;

/** Build the context menu for one set of labels. */
function buildTrayMenu(labels: MenuLabels): Menu {
  return Menu.buildFromTemplate([
    { label: labels.showWindow, click: () => showMainWindow() },
    { type: 'separator' },
    commandItem(labels.settings, MENU_COMMANDS.openSettings),
    commandItem(labels.usage, MENU_COMMANDS.showUsage),
    commandItem(labels.skills, MENU_COMMANDS.showSkills),
    commandItem(labels.about, MENU_COMMANDS.showAbout),
    { type: 'separator' },
    { label: labels.quit, role: 'quit' },
  ]);
}

/** Labels for the user's chosen language (the OS locale is only the `system` fallback). */
function currentLabels(): MenuLabels {
  return MENU_LABELS[
    resolveMenuLocaleForPreference(getConfigStore().get('language'), app.getLocale())
  ];
}

/**
 * Create the macOS Tray and its context menu. Idempotent — a second call is a no-op
 * (mirrors installAppMenu). Call after `app.whenReady()`. The menu strings follow the
 * user's language preference and are refreshed by `rebuildTrayLabels` when it changes.
 */
export function installTray(): void {
  if (tray) return;

  tray = new Tray(buildTrayImage());
  tray.setToolTip(app.name);
  tray.setContextMenu(buildTrayMenu(currentLabels()));

  log.info('tray.installed');
}

/**
 * Re-label the tray menu after the language preference changed. No-op when no tray
 * exists (non-macOS, or before install). Rebuilding the whole template is right here:
 * an Electron Menu's item labels are read-only once built.
 */
export function rebuildTrayLabels(): void {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu(currentLabels()));
}
