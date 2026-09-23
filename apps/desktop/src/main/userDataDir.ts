// Where an UNPACKAGED run (`pnpm dev`) keeps its userData, so it never shares a directory with the
// installed app.
//
// Electron derives the default from `productName`, and `pnpm dev` reads the same package.json the
// build does, so both resolved to `<appData>/AiOpt`. A dev run therefore read and wrote the
// developer's REAL installed state: `secrets/` (provider keys), `providers.json` (providers and
// agent bindings), `proxy.json` (loopback port + route tokens), `preferences.json`. A schema change
// or a bug under development could corrupt the data a real install depends on, and the shared
// single-instance lock (it lives in userData) meant dev and the installed app could not run side by
// side. See docs/dev-rules/credentials-and-local-storage.md §2.
//
// Kept Electron-free so the decision is unit-testable; bootstrap-electron.ts applies it.

import path from 'node:path';

/** Appended to the product name for an unpackaged run's userData directory. */
export const DEV_USER_DATA_SUFFIX = '-dev';

/** The slice of `node:path` this needs; a test passes `path.win32` to pin the Windows result. */
export type PathFlavour = Pick<typeof path, 'join'>;

export interface UserDataDirInput {
  /** `app.isPackaged` — false for `pnpm dev` / `electron-forge start`. */
  isPackaged: boolean;
  /** `app.getPath('appData')`: `%APPDATA%`, `~/Library/Application Support`, `~/.config`. */
  appData: string;
  /** `app.getName()` — the productName, `AiOpt`. */
  productName: string;
}

/**
 * The userData directory to set, or `null` to leave Electron's default alone.
 *
 * A packaged build always gets `null`: the shipped app's location is unchanged, so no installed
 * user's data moves. Only an unpackaged run is redirected, to a sibling of the default
 * (`AiOpt-dev` next to `AiOpt`) so it still follows each OS's convention for app data.
 */
export function devUserDataDir(input: UserDataDirInput, flavour: PathFlavour = path): string | null {
  if (input.isPackaged) return null;
  return flavour.join(input.appData, `${input.productName}${DEV_USER_DATA_SUFFIX}`);
}
