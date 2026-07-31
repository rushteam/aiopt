import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildViewSubmenu } from '../viewMenu';

type Role = NonNullable<MenuItemConstructorOptions['role']>;

/** Collect the `role` of every submenu item (skips separators, which have none). */
function roles(item: MenuItemConstructorOptions): Role[] {
  const submenu = item.submenu as MenuItemConstructorOptions[];
  return submenu.map((entry) => entry.role).filter((r): r is Role => r !== undefined);
}

const DEV_ONLY_ROLES = ['reload', 'forceReload', 'toggleDevTools'] as const;

describe('buildViewSubmenu', () => {
  it('carries the given label', () => {
    expect(buildViewSubmenu('View', false).label).toBe('View');
    expect(buildViewSubmenu('View', true).label).toBe('View');
  });

  it('includes reload / forceReload / toggleDevTools in development builds', () => {
    const dev = roles(buildViewSubmenu('View', false));
    for (const role of DEV_ONLY_ROLES) {
      expect(dev).toContain(role);
    }
  });

  it('strips reload / forceReload / toggleDevTools in packaged builds', () => {
    const packaged = roles(buildViewSubmenu('View', true));
    for (const role of DEV_ONLY_ROLES) {
      expect(packaged).not.toContain(role);
    }
  });

  it('keeps the zoom / fullscreen items in both builds', () => {
    for (const isPackaged of [false, true]) {
      const present = roles(buildViewSubmenu('View', isPackaged));
      for (const role of ['resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']) {
        expect(present).toContain(role);
      }
    }
  });
});
