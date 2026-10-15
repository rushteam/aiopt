import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidDevProfileError, devUserData, type UserDataDirInput } from '../userDataDir';

// A dev run used to resolve to the installed app's userData and read/write its real secrets,
// providers and proxy tokens. These pin both halves of the fix: the packaged location is left
// exactly as Electron chooses it, and an unpackaged run lands in a sibling `-dev` directory —
// or, with AIOPT_DEV_PROFILE, a named sibling or a throwaway temp directory.

const mac: UserDataDirInput = {
  isPackaged: false,
  appData: '/Users/bob/Library/Application Support',
  productName: 'AiOpt',
  tempDir: '/var/folders/xy/T',
};

describe('devUserData', () => {
  it('leaves a packaged build on Electron’s default', () => {
    expect(devUserData({ ...mac, isPackaged: true })).toBeNull();
  });

  it('ignores AIOPT_DEV_PROFILE in a packaged build, even an invalid one', () => {
    expect(devUserData({ ...mac, isPackaged: true, profile: 'pms' })).toBeNull();
    expect(devUserData({ ...mac, isPackaged: true, profile: 'temp' })).toBeNull();
    expect(devUserData({ ...mac, isPackaged: true, profile: '../../x' })).toBeNull();
  });

  it('moves an unpackaged run to a sibling -dev directory on macOS', () => {
    expect(devUserData(mac, path.posix)).toEqual({ kind: 'dir', dir: '/Users/bob/Library/Application Support/AiOpt-dev' });
    expect(devUserData({ ...mac, profile: '' }, path.posix)).toEqual({
      kind: 'dir',
      dir: '/Users/bob/Library/Application Support/AiOpt-dev',
    });
  });

  it('moves an unpackaged run to a sibling -dev directory on Linux', () => {
    expect(devUserData({ isPackaged: false, appData: '/home/bob/.config', productName: 'AiOpt' }, path.posix)).toEqual({
      kind: 'dir',
      dir: '/home/bob/.config/AiOpt-dev',
    });
  });

  it('moves an unpackaged run to a sibling -dev directory on Windows', () => {
    expect(
      devUserData({ isPackaged: false, appData: 'C:\\Users\\Bob\\AppData\\Roaming', productName: 'AiOpt' }, path.win32),
    ).toEqual({ kind: 'dir', dir: 'C:\\Users\\Bob\\AppData\\Roaming\\AiOpt-dev' });
  });

  it('never resolves an unpackaged run to the packaged directory', () => {
    const packagedDefault = path.posix.join(mac.appData, 'AiOpt');
    for (const profile of [undefined, 'pms']) {
      const r = devUserData({ ...mac, profile }, path.posix);
      expect(r?.kind).toBe('dir');
      const dir = r && r.kind === 'dir' ? r.dir : '';
      expect(dir).not.toBe(packagedDefault);
      // Not nested inside it either — a sibling, so neither can see or clean up the other's files.
      expect(dir.startsWith(`${packagedDefault}/`)).toBe(false);
    }
  });

  it('gives a named profile its own sibling directory', () => {
    expect(devUserData({ ...mac, profile: 'pms' }, path.posix)).toEqual({
      kind: 'dir',
      dir: '/Users/bob/Library/Application Support/AiOpt-dev-pms',
    });
    expect(
      devUserData({ isPackaged: false, appData: 'C:\\Users\\Bob\\AppData\\Roaming', productName: 'AiOpt', profile: 'feat_2-b' }, path.win32),
    ).toEqual({ kind: 'dir', dir: 'C:\\Users\\Bob\\AppData\\Roaming\\AiOpt-dev-feat_2-b' });
  });

  it('gives `temp` a mkdtemp prefix under the OS temp dir, not appData', () => {
    expect(devUserData({ ...mac, profile: 'temp' }, path.posix)).toEqual({ kind: 'temp', prefix: '/var/folders/xy/T/AiOpt-dev-' });
    expect(() => devUserData({ ...mac, profile: 'temp', tempDir: '' })).toThrow(InvalidDevProfileError);
  });

  it('refuses a profile that is not a plain name, so it can never become a path', () => {
    for (const profile of ['../x', '/tmp/x', 'a/b', 'a\\b', '.', '..', 'a b', 'x'.repeat(33), 'naïve', 'a\nb']) {
      expect(() => devUserData({ ...mac, profile }), profile).toThrow(InvalidDevProfileError);
    }
  });
});
