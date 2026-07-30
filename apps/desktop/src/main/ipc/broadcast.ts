// Push a one-way event to renderer windows.
//
// Only NON-secret notifications go through here (preference snapshots, auth
// signed-in/out state, update status) — never credential material — because the
// payload reaches every open window. See docs/dev-rules/credentials-and-local-storage.md.

import { BrowserWindow } from 'electron';

export function broadcastToRenderers(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
}
