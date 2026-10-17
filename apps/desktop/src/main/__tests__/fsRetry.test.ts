import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renameSyncWithRetry, rmrfSyncWithRetry } from '../fsRetry';

// These wrappers exist for Windows: a store's temp+rename commit, and the skills directory swap,
// both fail there when another process holds the file open (an agent CLI, Defender, an Explorer
// window), with EPERM/EACCES/EBUSY that clears in milliseconds. That cannot be reproduced on a
// POSIX host, so the retry POLICY is tested by making `fs.renameSync` fail on demand, and the
// happy paths are tested for real against the filesystem.

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-fsretry-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('renameSyncWithRetry', () => {
  it('renames over an existing destination', () => {
    const from = path.join(root, 'a');
    const to = path.join(root, 'b');
    fs.writeFileSync(from, 'new');
    fs.writeFileSync(to, 'old');
    renameSyncWithRetry(from, to);
    expect(fs.readFileSync(to, 'utf8')).toBe('new');
    expect(fs.existsSync(from)).toBe(false);
  });

  // The whole point: a lock that clears must not surface to the user as a failed bind.
  it.each(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])('retries %s and then succeeds', (code) => {
    let calls = 0;
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      calls += 1;
      if (calls <= 2) throw errno(code);
      return real(from, to);
    });
    const from = path.join(root, 'a');
    fs.writeFileSync(from, 'x');
    renameSyncWithRetry(from, path.join(root, 'b'));
    expect(spy).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(path.join(root, 'b'), 'utf8')).toBe('x');
  });

  // A real refusal must stay a refusal, and must not spend the retry budget waiting for a
  // condition that will never clear.
  it('rethrows a non-transient error on the first attempt', () => {
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw errno('ENOENT');
    });
    expect(() => renameSyncWithRetry(path.join(root, 'nope'), path.join(root, 'b'))).toThrow(
      /ENOENT/,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget and rethrows the transient error unchanged', () => {
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw errno('EBUSY');
    });
    expect(() => renameSyncWithRetry(path.join(root, 'a'), path.join(root, 'b'))).toThrow(/EBUSY/);
    // One initial attempt plus MAX_RETRIES.
    expect(spy).toHaveBeenCalledTimes(4);
  });
});

describe('rmrfSyncWithRetry', () => {
  it('removes a tree and tolerates absence', () => {
    const dir = path.join(root, 'tree', 'deep');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
    const tree = path.join(root, 'tree');
    rmrfSyncWithRetry(tree);
    expect(fs.existsSync(tree)).toBe(false);
    expect(() => rmrfSyncWithRetry(tree)).not.toThrow();
  });

  it('unlinks a directory link inside the tree without touching its target', () => {
    const outside = path.join(root, 'user-work');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'mine');
    const tree = path.join(root, 'skill');
    fs.mkdirSync(tree);
    fs.symlinkSync(outside, path.join(tree, 'linked'), 'junction');
    rmrfSyncWithRetry(tree);
    expect(fs.existsSync(tree)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('removes a link passed as the target itself, not what it points at', () => {
    const outside = path.join(root, 'real');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'mine');
    const link = path.join(root, 'link');
    fs.symlinkSync(outside, link, 'junction');
    rmrfSyncWithRetry(link);
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  });

  it('retries a busy directory', () => {
    const tree = path.join(root, 'busy');
    fs.mkdirSync(tree);
    const real = fs.rmdirSync;
    let n = 0;
    vi.spyOn(fs, 'rmdirSync').mockImplementation((p) => {
      if (n++ === 0) throw errno('EBUSY');
      real(p);
    });
    rmrfSyncWithRetry(tree);
    expect(fs.existsSync(tree)).toBe(false);
  });
});
