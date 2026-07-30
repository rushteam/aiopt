// Synchronous theme-preference read — the ONE blocking IPC in the app.
//
// The renderer needs the stored theme before its first paint to avoid flashing
// the wrong colors, and an async `invoke` can't guarantee that ordering. This
// `sendSync` handler is deliberately tiny: authorize the sender, read the
// already-in-memory config store, return the value. It never writes or exposes
// anything beyond the theme string. A rejected/failed call falls back to
// `system` so a hostile or early caller learns nothing and gets a safe default.

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { IPC_SYNC_CHANNELS, type ThemePreference } from '../../shared/ipc-channels';
import { assertTrustedAppRendererEvent } from '../security/trustedSender';
import { getConfigStore } from '../services';

export function installThemeSyncChannel(): void {
  ipcMain.on(IPC_SYNC_CHANNELS.themeGet, (event: IpcMainEvent) => {
    const fallback: ThemePreference = 'system';
    try {
      // IpcMainEvent carries the same senderFrame / sender.mainFrame the check
      // reads; the trusted-sender identity comes only from those Electron fields.
      assertTrustedAppRendererEvent(event as unknown as IpcMainInvokeEvent);
      event.returnValue = getConfigStore().get('theme');
    } catch {
      event.returnValue = fallback;
    }
  });
}
