// One-way "quit the app" channel — the in-app menu's explicit exit.
//
// On macOS the red close button only HIDES the window to the tray (see
// window/mainWindow.ts, gated on tray.isQuitting()); a real exit comes only from
// ⌘Q, the native menu Quit, or the tray Quit. The in-app hamburger has no OS menu
// behind it, so it needs this path: a raw one-way send that authorizes the sender,
// then calls `app.quit()`. That fires `before-quit` → `markQuitting()`, which flips
// the quit flag so the window's close handler stops hiding and the app truly exits.
//
// Quit is an ACTION main performs, so it is NOT a `MenuCommand` (those are
// main → renderer). Like the theme sync + shortcut recording channels, it uses raw
// ipcMain with a direct trusted-sender assertion and fails safe — an untrusted or
// early caller is ignored and learns nothing. A clean exit is the entire effect:
// preferences persist, no data is destroyed, no secret is exposed, no privilege is
// gained.

import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { IPC_SEND_CHANNELS } from '../../shared/ipc-channels';
import { assertTrustedAppRendererEvent } from '../security/trustedSender';

export function installAppQuitChannel(): void {
  ipcMain.on(IPC_SEND_CHANNELS.appQuit, (event: IpcMainEvent) => {
    try {
      assertTrustedAppRendererEvent(event as unknown as IpcMainInvokeEvent);
    } catch {
      return; // Untrusted sender: ignore silently, never quit.
    }
    app.quit();
  });
}
