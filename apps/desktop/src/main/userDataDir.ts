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
// `AIOPT_DEV_PROFILE` splits dev runs further, so two checkouts can run side by side (each
// userData has its own single-instance lock):
//   - a NAME (`pms`) gives `<appData>/AiOpt-dev-pms`, persistent like `AiOpt-dev`;
//   - `temp` gives a fresh private directory under the OS temp dir, removed on exit.
// It is a name, never a path: renderer-free, but still keep a typo or a crafted value from
// pointing a run's secrets/tokens at a shared or Git-tracked location. A packaged build ignores it.
//
// Kept Electron-free so the decision is unit-testable; bootstrap-electron.ts applies it.

import path from 'node:path';

/** Appended to the product name for an unpackaged run's userData directory. */
export const DEV_USER_DATA_SUFFIX = '-dev';

/** Environment variable that picks a separate dev userData (a profile name or `temp`). */
export const DEV_PROFILE_ENV = 'AIOPT_DEV_PROFILE';

/** The profile value that asks for a throwaway directory instead of a named one. */
export const DEV_PROFILE_TEMP = 'temp';

const PROFILE_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/** The slice of `node:path` this needs; a test passes `path.win32` to pin the Windows result. */
export type PathFlavour = Pick<typeof path, 'join'>;

export interface UserDataDirInput {
  /** `app.isPackaged` — false for `pnpm dev` / `electron-forge start`. */
  isPackaged: boolean;
  /** `app.getPath('appData')`: `%APPDATA%`, `~/Library/Application Support`, `~/.config`. */
  appData: string;
  /** `app.getName()` — the productName, `AiOpt`. */
  productName: string;
  /** `process.env.AIOPT_DEV_PROFILE`; unset or empty means the plain `-dev` directory. */
  profile?: string;
  /** `os.tmpdir()` — per-user on macOS (`$TMPDIR`) and Windows; only read for `temp`. */
  tempDir?: string;
}

/** Where a dev run's userData goes: a fixed directory, or a fresh one made from `prefix`. */
export type DevUserData = { kind: 'dir'; dir: string } | { kind: 'temp'; prefix: string };

/** Thrown for an `AIOPT_DEV_PROFILE` that is not a plain name, so the run stops instead of guessing. */
export class InvalidDevProfileError extends Error {
  constructor() {
    super(`${DEV_PROFILE_ENV} must be ${DEV_PROFILE_TEMP} or 1-32 letters, digits, '-' or '_'`);
    this.name = 'InvalidDevProfileError';
  }
}

/**
 * The userData to use, or `null` to leave Electron's default alone.
 *
 * A packaged build always gets `null`, whatever the environment says: the shipped app's location is
 * unchanged, so no installed user's data moves. Only an unpackaged run is redirected, to a sibling
 * of the default (`AiOpt-dev`, or `AiOpt-dev-<profile>`) so it still follows each OS's convention
 * for app data, or to a throwaway directory under the OS temp dir for `temp`.
 */
export function devUserData(input: UserDataDirInput, flavour: PathFlavour = path): DevUserData | null {
  if (input.isPackaged) return null;
  const base = `${input.productName}${DEV_USER_DATA_SUFFIX}`;
  const profile = input.profile ?? '';
  if (profile === '') return { kind: 'dir', dir: flavour.join(input.appData, base) };
  if (!PROFILE_NAME.test(profile)) throw new InvalidDevProfileError();
  if (profile === DEV_PROFILE_TEMP) {
    if (!input.tempDir) throw new InvalidDevProfileError();
    return { kind: 'temp', prefix: flavour.join(input.tempDir, `${base}-`) };
  }
  return { kind: 'dir', dir: flavour.join(input.appData, `${base}-${profile}`) };
}

