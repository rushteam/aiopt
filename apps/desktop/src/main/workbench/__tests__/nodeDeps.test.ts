import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeWorkbenchFs } from '../nodeDeps';

describe('nodeWorkbenchFs.readRegularFileHead', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-wb-nodedeps-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the head of a regular file with its full size', () => {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'hello world');
    expect(nodeWorkbenchFs.readRegularFileHead(file, 5)).toEqual({ head: 'hello', size: 11 });
    fs.writeFileSync(path.join(dir, 'empty'), '');
    expect(nodeWorkbenchFs.readRegularFileHead(path.join(dir, 'empty'), 5)).toEqual({ head: '', size: 0 });
  });

  it('refuses a symlink, a directory, a missing file and (POSIX) a FIFO without blocking', () => {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'x');
    expect(nodeWorkbenchFs.readRegularFileHead(dir, 5)).toBeNull();
    expect(nodeWorkbenchFs.readRegularFileHead(path.join(dir, 'missing'), 5)).toBeNull();
    // Windows has no O_NOFOLLOW / FIFOs (and symlinks need a privilege); main resolves links first there.
    if (process.platform !== 'win32') {
      fs.symlinkSync(file, path.join(dir, 'link'));
      expect(nodeWorkbenchFs.readRegularFileHead(path.join(dir, 'link'), 5)).toBeNull();
      const fifo = path.join(dir, 'fifo');
      execFileSync('mkfifo', [fifo]);
      expect(nodeWorkbenchFs.readRegularFileHead(fifo, 5)).toBeNull();
    }
  });
});

describe('nodeWorkbenchFs.readRegularFileTail / removeEmptyDir', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-wb-nodedeps-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the tail of a regular file with its full size, and refuses a directory', () => {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'hello world');
    expect(nodeWorkbenchFs.readRegularFileTail(file, 5)).toEqual({ tail: 'world', size: 11 });
    expect(nodeWorkbenchFs.readRegularFileTail(file, 50)).toEqual({ tail: 'hello world', size: 11 });
    expect(nodeWorkbenchFs.readRegularFileTail(dir, 5)).toBeNull();
    if (process.platform !== 'win32') {
      fs.symlinkSync(file, path.join(dir, 'link'));
      expect(nodeWorkbenchFs.readRegularFileTail(path.join(dir, 'link'), 5)).toBeNull();
    }
  });

  it('removes only an empty directory', () => {
    const full = path.join(dir, 'full');
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, 'x'), 'x');
    nodeWorkbenchFs.removeEmptyDir(full);
    expect(fs.existsSync(full)).toBe(true);
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    nodeWorkbenchFs.removeEmptyDir(empty);
    expect(fs.existsSync(empty)).toBe(false);
    nodeWorkbenchFs.removeEmptyDir(path.join(dir, 'missing'));
  });
});
