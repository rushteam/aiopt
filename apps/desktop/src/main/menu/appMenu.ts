// The native application menu.
//
// Built from a template with Electron roles for the standard editing/window
// behaviour, plus three CUSTOM items (Settings, Check for Updates, About) that
// dispatch a `MenuCommand` to the renderer through `IPC_EVENTS.menuCommand`. The
// menu is the ONLY place these commands originate; the command vocabulary itself
// lives in shared/menuCommands.ts and is reused by preload + renderer.
//
// Accelerators are DERIVED from the app-shortcut store, not hard-coded: the
// effective combo for each menu-backed shortcut is converted to an Electron
// accelerator by the same shared/appShortcuts code the renderer uses, so a rebind
// updates the menu binding and the Shortcuts page together. The menu rebuilds when
// overrides change, and while the settings page is recording a keystroke the
// accelerators are left UNREGISTERED (still shown) so capturing e.g. ⌘, doesn't
// also fire "open Settings".
//
// Platform shape: on macOS the first submenu is the bold app menu (About /
// Settings / Check for Updates / Quit); elsewhere those land under File and Help.

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import { MENU_COMMANDS, type MenuCommand } from '../../shared/menuCommands';
import {
  comboToElectronAccelerator,
  type AppShortcutId,
} from '../../shared/appShortcuts';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import { MENU_LABELS, resolveMenuLocale, type MenuLabels } from './menuLabels';
import { getAppShortcutStore } from '../services';
import {
  isAppShortcutRecordingActive,
  subscribeAppShortcutRecording,
} from '../app-shortcuts/appShortcutIpc';
import { logger } from '../logger';

const log = logger.child('menu');

/** Dispatch a menu command to the focused renderer (fall back to the first window). */
function dispatchToRenderer(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) {
    log.warn('menu.command_no_window', { command });
    return;
  }
  win.webContents.send(IPC_EVENTS.menuCommand, command);
  log.info('menu.command', { command });
}

/**
 * The Electron accelerator for a menu-backed shortcut, or undefined when it has no
 * expressible / non-disabled binding. Taken from the store's effective combos, so
 * it tracks user rebinds.
 */
function acceleratorFor(id: AppShortcutId): string | undefined {
  const [primary] = getAppShortcutStore().getEffectiveCombos(id);
  if (!primary) return undefined;
  return comboToElectronAccelerator(primary, process.platform) ?? undefined;
}

function buildTemplate(labels: MenuLabels): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin';
  // While recording, show the accelerator but DON'T register it with the system,
  // so the captured keystroke reaches the settings page instead of the menu.
  const registerAccelerator = !isAppShortcutRecordingActive();

  const settingsItem: MenuItemConstructorOptions = {
    label: labels.settings,
    accelerator: acceleratorFor('open-settings'),
    registerAccelerator,
    click: () => dispatchToRenderer(MENU_COMMANDS.openSettings),
  };
  const updatesItem: MenuItemConstructorOptions = {
    label: labels.checkForUpdates,
    accelerator: acceleratorFor('check-for-updates'),
    registerAccelerator,
    click: () => dispatchToRenderer(MENU_COMMANDS.checkForUpdates),
  };
  const aboutItem: MenuItemConstructorOptions = {
    label: labels.about,
    click: () => dispatchToRenderer(MENU_COMMANDS.showAbout),
  };

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        aboutItem,
        { type: 'separator' },
        settingsItem,
        updatesItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: labels.quit, role: 'quit' },
      ],
    });
  }

  template.push({
    label: labels.file,
    submenu: isMac
      ? [{ role: 'close' }]
      : [settingsItem, { type: 'separator' }, { label: labels.quit, role: 'quit' }],
  });

  template.push({ label: labels.edit, role: 'editMenu' });
  template.push({ label: labels.view, role: 'viewMenu' });
  template.push({ label: labels.window, role: 'windowMenu' });

  template.push({
    label: labels.help,
    role: 'help',
    submenu: isMac ? [updatesItem] : [updatesItem, { type: 'separator' }, aboutItem],
  });

  return template;
}

let installed = false;

/** Rebuild + install the native menu for the app's locale. */
function rebuildMenu(): void {
  const labels = MENU_LABELS[resolveMenuLocale(app.getLocale())];
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(labels)));
}

/**
 * Build the native menu and keep it in sync: rebuild when shortcut overrides change
 * (so a rebind re-binds the accelerator) and when the recording gate toggles (so
 * accelerators pause / resume). Idempotent — the subscriptions are installed once.
 */
export function installAppMenu(): void {
  rebuildMenu();
  if (installed) return;
  installed = true;
  getAppShortcutStore().subscribe(() => rebuildMenu());
  subscribeAppShortcutRecording(() => rebuildMenu());
}
