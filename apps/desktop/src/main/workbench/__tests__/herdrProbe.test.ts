import { describe, expect, it, vi } from 'vitest';
import { isValidHerdrSshTarget } from '../../../shared/workbench';
import {
  herdrExecForTarget,
  herdrSpawnArgv,
  managedHerdrBinary,
  resolveLocalHerdrBinary,
} from '../herdrProbe';

describe('resolveLocalHerdrBinary', () => {
  it('prefers herdr on PATH when both PATH and managed copies exist', () => {
    const managed = managedHerdrBinary('/data/wb');
    const hit = resolveLocalHerdrBinary({
      workbenchDataDir: '/data/wb',
      pathEnv: '/usr/bin',
      homeDir: '/home/u',
      isExecutable: (p) => p === managed || p === '/usr/bin/herdr',
    });
    expect(hit).toEqual({ binary: '/usr/bin/herdr', source: 'path' });
  });

  it('uses the managed copy when PATH has no herdr', () => {
    const managed = managedHerdrBinary('/data/wb');
    const hit = resolveLocalHerdrBinary({
      workbenchDataDir: '/data/wb',
      pathEnv: '/usr/bin',
      homeDir: '/home/u',
      isExecutable: (p) => p === managed,
    });
    expect(hit).toEqual({ binary: managed, source: 'managed' });
  });

  it('returns null when neither PATH nor managed has herdr', () => {
    const hit = resolveLocalHerdrBinary({
      workbenchDataDir: '/data/wb',
      pathEnv: '/usr/bin',
      homeDir: '/home/u',
      isExecutable: () => false,
    });
    expect(hit).toEqual({ binary: null, source: null });
  });
});

describe('herdrExecForTarget', () => {
  it('wraps exec with ssh when a target is set', async () => {
    const base = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const exec = herdrExecForTarget(base, 'dev@host');
    await exec('/ignored', ['workspace', 'list'], 1000);
    expect(base).toHaveBeenCalledWith(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'dev@host', 'herdr', 'workspace', 'list'],
      1000,
    );
  });
});

describe('herdrSpawnArgv', () => {
  it('uses ssh for a remote server start', () => {
    expect(herdrSpawnArgv('u@h', '/local/herdr', ['--session', 'aiopt', 'server'])).toEqual({
      file: 'ssh',
      argv: ['u@h', 'herdr', '--session', 'aiopt', 'server'],
    });
  });
});

describe('isValidHerdrSshTarget', () => {
  it('rejects shell metacharacters', () => {
    expect(isValidHerdrSshTarget('user@host')).toBe(true);
    expect(isValidHerdrSshTarget('user@host; rm -rf /')).toBe(false);
  });
});
