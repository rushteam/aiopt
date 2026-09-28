// Absolute directory for the central skills library, from the enum preference.
//
// Electron-free so the three locations can be asserted without a running app, including
// the Windows join (pass `path.win32`). `skillsLibraryPath` in main/paths.ts supplies the
// real `userData` / `home` roots from `app.getPath`. The renderer never chooses a path.

import path from 'node:path';
import type { SkillsLibraryLocation } from '../../shared/skills';

/** The slice of `node:path` this needs; a test passes `path.win32` to pin the Windows result. */
export type PathJoin = Pick<typeof path, 'join'>;

/**
 * `'app'` → `<userData>/skills`
 * `'home'` → `<home>/.aiopt/skills`
 * `'agents'` → `<home>/.agents/skills` — the cross-client user skills directory
 * (Agent Skills client guide). Home-level, so it is not a project `.agents/` that
 * Git would track.
 */
export function skillsLibraryDir(
  location: SkillsLibraryLocation,
  roots: { userData: string; home: string },
  flavour: PathJoin = path,
): string {
  switch (location) {
    case 'app':
      return flavour.join(roots.userData, 'skills');
    case 'home':
      return flavour.join(roots.home, '.aiopt', 'skills');
    case 'agents':
      return flavour.join(roots.home, '.agents', 'skills');
    default: {
      const exhaustive: never = location;
      return exhaustive;
    }
  }
}
