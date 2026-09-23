import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { homeRelativeDisplayPath } from '../displayPath';

// Both the agent config panel and the Skills store shorten a home-rooted path to `~/…` before it
// crosses IPC, so the renderer never displays the user's account name. Each used to do it with
// `abs.startsWith(`${home}/`)`, which is POSIX-only: on Windows the prefix never matched and the
// full `C:\Users\<name>\…` path was shown instead. These tests pin the WINDOWS behaviour by
// injecting `path.win32`, so they fail on a macOS or Linux runner if that regresses — the
// property could not be expressed at all while the separator was hard-coded.

describe('homeRelativeDisplayPath — win32', () => {
  const home = 'C:\\Users\\Bob';
  const shorten = (abs: string): string => homeRelativeDisplayPath(abs, home, path.win32);

  it('shortens a home-rooted Windows path and forward-slashes the result', () => {
    expect(shorten('C:\\Users\\Bob\\.codex\\auth.json')).toBe('~/.codex/auth.json');
    expect(shorten('C:\\Users\\Bob\\.config\\opencode\\opencode.json')).toBe(
      '~/.config/opencode/opencode.json',
    );
  });

  it('never leaks the account name for a path inside home', () => {
    expect(shorten('C:\\Users\\Bob\\.claude\\settings.json')).not.toContain('Bob');
  });

  it('reports home itself as ~', () => {
    expect(shorten(home)).toBe('~');
  });

  it('leaves a path outside home alone', () => {
    expect(shorten('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe(
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
    );
  });

  it('leaves a path on another drive alone rather than mislabelling it ~', () => {
    // path.win32.relative across drives returns an ABSOLUTE path, not a `..` chain.
    expect(shorten('D:\\Users\\Bob\\.codex\\auth.json')).toBe('D:\\Users\\Bob\\.codex\\auth.json');
  });

  it('does not shorten a sibling directory that merely shares the home prefix', () => {
    expect(shorten('C:\\Users\\Bobby\\.codex\\auth.json')).toBe('C:\\Users\\Bobby\\.codex\\auth.json');
  });

  it('is case-insensitive about the home prefix, as NTFS is', () => {
    // path.win32.relative case-folds, so a differently-cased home still shortens rather than
    // showing the user an unshortened path for the same file.
    expect(shorten('c:\\users\\bob\\.codex\\auth.json')).toBe('~/.codex/auth.json');
  });

  it('treats a dot-leading name inside home as contained', () => {
    expect(shorten('C:\\Users\\Bob\\..foo')).toBe('~/..foo');
  });
});

describe('homeRelativeDisplayPath — posix', () => {
  const home = '/home/bob';
  const shorten = (abs: string): string => homeRelativeDisplayPath(abs, home, path.posix);

  it('shortens a home-rooted path', () => {
    expect(shorten('/home/bob/.codex/auth.json')).toBe('~/.codex/auth.json');
    expect(shorten(home)).toBe('~');
  });

  it('leaves a path outside home alone', () => {
    expect(shorten('/etc/passwd')).toBe('/etc/passwd');
  });

  it('does not shorten a sibling that shares the prefix', () => {
    expect(shorten('/home/bobby/.codex/auth.json')).toBe('/home/bobby/.codex/auth.json');
  });

  it('is case-SENSITIVE on posix, where two spellings are two files', () => {
    expect(shorten('/Home/Bob/.codex/auth.json')).toBe('/Home/Bob/.codex/auth.json');
  });
});

describe('homeRelativeDisplayPath — default flavour', () => {
  it('uses the host separator when none is injected', () => {
    const home = path.join(path.sep, 'tmp', 'aiopt-home');
    expect(homeRelativeDisplayPath(path.join(home, '.codex', 'auth.json'), home)).toBe(
      '~/.codex/auth.json',
    );
  });
});
