import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { devUserDataDir } from '../userDataDir';

// A dev run used to resolve to the installed app's userData and read/write its real secrets,
// providers and proxy tokens. These pin both halves of the fix: the packaged location is left
// exactly as Electron chooses it, and an unpackaged run lands in a sibling `-dev` directory.

describe('devUserDataDir', () => {
  it('leaves a packaged build on Electron’s default', () => {
    expect(
      devUserDataDir({ isPackaged: true, appData: '/Users/bob/Library/Application Support', productName: 'AiOpt' }),
    ).toBeNull();
  });

  it('moves an unpackaged run to a sibling -dev directory on macOS', () => {
    expect(
      devUserDataDir(
        { isPackaged: false, appData: '/Users/bob/Library/Application Support', productName: 'AiOpt' },
        path.posix,
      ),
    ).toBe('/Users/bob/Library/Application Support/AiOpt-dev');
  });

  it('moves an unpackaged run to a sibling -dev directory on Linux', () => {
    expect(
      devUserDataDir({ isPackaged: false, appData: '/home/bob/.config', productName: 'AiOpt' }, path.posix),
    ).toBe('/home/bob/.config/AiOpt-dev');
  });

  it('moves an unpackaged run to a sibling -dev directory on Windows', () => {
    expect(
      devUserDataDir(
        { isPackaged: false, appData: 'C:\\Users\\Bob\\AppData\\Roaming', productName: 'AiOpt' },
        path.win32,
      ),
    ).toBe('C:\\Users\\Bob\\AppData\\Roaming\\AiOpt-dev');
  });

  it('never resolves an unpackaged run to the packaged directory', () => {
    const appData = '/Users/bob/Library/Application Support';
    const packagedDefault = path.posix.join(appData, 'AiOpt');
    const dev = devUserDataDir({ isPackaged: false, appData, productName: 'AiOpt' }, path.posix);
    expect(dev).not.toBe(packagedDefault);
    // Not nested inside it either — a sibling, so neither can see or clean up the other's files.
    expect(dev!.startsWith(`${packagedDefault}/`)).toBe(false);
  });
});
