// Shared helper: push a `MenuCommand` to the renderer over the one-way
// `IPC_EVENTS.menuCommand` channel. This is the ONLY origin of these commands, and
// the vocabulary lives in shared/menuCommands.ts. Both the native app menu
// (menu/appMenu.ts) and the macOS Tray (tray/tray.ts) dispatch through here so
// there is a single copy of the "find a window, send the command" logic.

import { BrowserWindow } from 'electron';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import type { MenuCommand } from '../../shared/menuCommands';
import { logger } from '../logger';

const log = logger.child('menu');

/** Dispatch a menu command to the focused renderer (fall back to the first window). */
export function dispatchToRenderer(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) {
    log.warn('menu.command_no_window', { command });
    return;
  }
  win.webContents.send(IPC_EVENTS.menuCommand, command);
  log.info('menu.command', { command });
}
