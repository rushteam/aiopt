import { describe, expect, it, vi } from 'vitest';
import { isValidHerdrSshTarget } from '../../../shared/workbench';
import {
  herdrExecForTarget,
  herdrSpawnArgv,
  managedHerdrBinary,
  resolveLocalHerdrBinary,
} from '../herdrProbe';

describe('resolveLocalHerdrBinary', () => {
  it('prefers the managed copy under the workbench data dir', () => {
    const managed = managedHerdrBinary('/data/wb');
    const hit = resolveLocalHerdrBinary({
      workbenchDataDir: '/data/wb',
      pathEnv: '/usr/bin',
      homeDir: '/home/u',
      isExecutable: (p) => p === managed || p === '/usr/bin/herdr',
    });
    expect(hit).toEqual({ binary: managed, source: 'managed' });
  });

  it('falls back to PATH when managed copy is missing', () => {
    const hit = resolveLocalHerdrBinary({
      workbenchDataDir: '/data/wb',
      pathEnv: '/usr/bin',
      homeDir: '/home/u',
      isExecutable: (p) => p === '/usr/bin/herdr',
    });
    expect(hit).toEqual({ binary: '/usr/bin/herdr', source: 'path' });
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
