// The View submenu, split out as a PURE builder (type-only Electron import, no
// runtime dependency) so the dev-vs-production shape can be unit-tested without
// booting Electron.
//
// Reload and DevTools are development affordances. In a PACKAGED build we strip
// `reload` / `forceReload` / `toggleDevTools`, which also removes their default
// accelerators (⌘R / ⇧⌘R / ⌥⌘I) — so end users get no menu item AND no keyboard
// shortcut to open DevTools or force a full renderer reload. This is the visible
// half of the guard; the main window additionally sets `webPreferences.devTools:
// false` in production as a hard backstop that disables DevTools entirely, even
// against programmatic or built-in shortcuts (see window/mainWindow.ts). Mirrors
// Cindy's release View menu.

import { type MenuItemConstructorOptions } from 'electron';

export function buildViewSubmenu(label: string, isPackaged: boolean): MenuItemConstructorOptions {
  const devOnly: MenuItemConstructorOptions[] = isPackaged
    ? []
    : [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
      ];
  return {
    label,
    submenu: [
      ...devOnly,
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
}
