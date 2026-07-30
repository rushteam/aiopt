// The native application menu.
//
// Built from a template with Electron roles for the standard editing/window
// behaviour, plus three CUSTOM items (Settings, Check for Updates, About) that
// dispatch a `MenuCommand` to the renderer through `IPC_EVENTS.menuCommand`. The
// menu is the ONLY place these commands originate; the command vocabulary itself
// lives in shared/menuCommands.ts and is reused by preload + renderer.
//
// Platform shape: on macOS the first submenu is the bold app menu (About /
// Settings / Check for Updates / Quit); elsewhere those land under File and Help.

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import { MENU_COMMANDS, type MenuCommand } from '../../shared/menuCommands';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import { MENU_LABELS, resolveMenuLocale, type MenuLabels } from './menuLabels';
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

function buildTemplate(labels: MenuLabels): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin';

  const settingsItem: MenuItemConstructorOptions = {
    label: labels.settings,
    accelerator: 'CmdOrCtrl+,',
    click: () => dispatchToRenderer(MENU_COMMANDS.openSettings),
  };
  const updatesItem: MenuItemConstructorOptions = {
    label: labels.checkForUpdates,
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

/** Build the native menu for the app's locale and install it as the app menu. */
export function installAppMenu(): void {
  const labels = MENU_LABELS[resolveMenuLocale(app.getLocale())];
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(labels)));
}
