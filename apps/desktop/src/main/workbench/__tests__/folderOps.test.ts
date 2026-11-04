import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeIpcError } from '../../../shared/ipc-errors';
import { WORKBENCH_LIMITS } from '../../../shared/workbench';
import type { Logger } from '../../logger';
import { copyName, createFolderOps, type FolderOpsDeps } from '../folderOps';
import { buildFolderImportConfirm } from '../folderImportConfirm';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return decodeIpcError((err as Error).message).code;
  }
  return 'none';
}

async function codeOfAsync(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return decodeIpcError((err as Error).message).code;
  }
  return 'none';
}

let tmp: string;
let rootA: string;
let rootB: string;
let outside: string;

function write(p: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function setup(over: Partial<FolderOpsDeps> = {}) {
  const trash = vi.fn(async (abs: string) => {
    fs.rmSync(abs, { recursive: true });
  });
  const confirmImport = vi.fn(async () => true);
  const writeClipboard = vi.fn();
  const ops = createFolderOps({
    platform: process.platform,
    folder: (id) => {
      if (id === 'a') return { root: rootA, name: 'A' };
      if (id === 'b') return { root: rootB, name: 'B' };
      const err = new Error('[NOT_FOUND] folder not found');
      (err as { code?: string }).code = 'NOT_FOUND';
      throw err;
    },
    trash,
    confirmImport,
    writeClipboard,
    logger: silent,
    ...over,
  });
  return { ops, trash, confirmImport, writeClipboard };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-folderops-')));
  rootA = path.join(tmp, 'a');
  rootB = path.join(tmp, 'b');
  outside = path.join(tmp, 'outside');
  write(path.join(rootA, 'src', 'main.ts'), 'main');
  write(path.join(rootA, 'notes.txt'), 'notes');
  fs.mkdirSync(rootB, { recursive: true });
  write(path.join(outside, 'secret.txt'), 'secret');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('copyName', () => {
  it('inserts " copy" before the extension, numbering after the first', () => {
    expect(copyName('notes.txt', 'file', 1)).toBe('notes copy.txt');
    expect(copyName('notes.txt', 'file', 3)).toBe('notes copy 3.txt');
    expect(copyName('.env', 'file', 1)).toBe('.env copy');
    expect(copyName('lib.v2', 'dir', 1)).toBe('lib.v2 copy');
  });
});

describe('folderOps', () => {
  it('creates files and directories, refusing a taken or invalid name', () => {
    const { ops } = setup();
    expect(ops.create('a', 'src', 'util.ts', 'file')).toBe('src/util.ts');
    expect(fs.readFileSync(path.join(rootA, 'src', 'util.ts'), 'utf8')).toBe('');
    expect(ops.create('a', '', 'docs', 'dir')).toBe('docs');
    expect(fs.statSync(path.join(rootA, 'docs')).isDirectory()).toBe(true);
    expect(codeOf(() => ops.create('a', 'src', 'main.ts', 'file'))).toBe('ALREADY_EXISTS');
    expect(fs.readFileSync(path.join(rootA, 'src', 'main.ts'), 'utf8')).toBe('main');
    for (const bad of ['..', 'a/b', '.git', 'node_modules', '', ' x', 'x.', 'x ']) {
      expect(codeOf(() => ops.create('a', '', bad, 'file'))).toBe('INVALID_PARAMS');
    }
    expect(codeOf(() => ops.create('a', 'notes.txt', 'x', 'file'))).toBe('INVALID_PARAMS');
    expect(codeOf(() => ops.create('a', '../outside', 'x', 'file'))).toBe('INVALID_PARAMS');
    expect(codeOf(() => ops.create('zz', '', 'x', 'file'))).toBe('NOT_FOUND');
  });

  it('renames in place without overwriting', () => {
    const { ops } = setup();
    expect(ops.rename('a', 'notes.txt', 'readme.md')).toBe('readme.md');
    expect(fs.existsSync(path.join(rootA, 'readme.md'))).toBe(true);
    expect(codeOf(() => ops.rename('a', 'readme.md', 'src'))).toBe('ALREADY_EXISTS');
    expect(codeOf(() => ops.rename('a', '', 'x'))).toBe('INVALID_PARAMS');
    expect(codeOf(() => ops.rename('a', 'missing', 'x'))).toBe('NOT_FOUND');
    // A case-only rename works on case-insensitive disks and plain disks alike.
    expect(ops.rename('a', 'readme.md', 'README.md')).toBe('README.md');
    expect(fs.readdirSync(rootA)).toContain('README.md');
  });

  it('moves to trash through the injected trash only, never the folder root', async () => {
    const { ops, trash } = setup();
    await ops.trash('a', 'src');
    expect(trash).toHaveBeenCalledWith(path.join(rootA, 'src'));
    expect(await codeOfAsync(ops.trash('a', ''))).toBe('INVALID_PARAMS');
    expect(await codeOfAsync(ops.trash('a', 'src'))).toBe('NOT_FOUND');
  });

  it('copies with an auto-renamed name and moves across folders', () => {
    const { ops } = setup();
    expect(ops.transfer('copy', { folderId: 'a', relPath: 'notes.txt' }, { folderId: 'a', relPath: '' })).toBe('notes copy.txt');
    expect(ops.transfer('copy', { folderId: 'a', relPath: 'notes.txt' }, { folderId: 'a', relPath: '' })).toBe('notes copy 2.txt');
    expect(ops.transfer('copy', { folderId: 'a', relPath: 'src' }, { folderId: 'b', relPath: '' })).toBe('src');
    expect(fs.readFileSync(path.join(rootB, 'src', 'main.ts'), 'utf8')).toBe('main');
    expect(ops.transfer('move', { folderId: 'a', relPath: 'notes.txt' }, { folderId: 'a', relPath: 'src' })).toBe('src/notes.txt');
    expect(fs.existsSync(path.join(rootA, 'notes.txt'))).toBe(false);
    expect(ops.transfer('move', { folderId: 'a', relPath: 'src' }, { folderId: 'b', relPath: '' })).toBe('src copy');
    expect(fs.existsSync(path.join(rootA, 'src'))).toBe(false);
    expect(fs.readFileSync(path.join(rootB, 'src copy', 'notes.txt'), 'utf8')).toBe('notes');
    // Moving within the same directory is a no-op.
    expect(ops.transfer('move', { folderId: 'b', relPath: 'src' }, { folderId: 'b', relPath: '' })).toBe('src');
  });

  it('refuses copying or moving a folder into itself', () => {
    const { ops } = setup();
    fs.mkdirSync(path.join(rootA, 'src', 'deep'));
    for (const op of ['copy', 'move'] as const) {
      expect(codeOf(() => ops.transfer(op, { folderId: 'a', relPath: 'src' }, { folderId: 'a', relPath: 'src' }))).toBe('INVALID_PARAMS');
      expect(codeOf(() => ops.transfer(op, { folderId: 'a', relPath: 'src' }, { folderId: 'a', relPath: 'src/deep' }))).toBe(
        'INVALID_PARAMS',
      );
    }
    expect(codeOf(() => ops.transfer('copy', { folderId: 'a', relPath: '' }, { folderId: 'b', relPath: '' }))).toBe('INVALID_PARAMS');
  });

  it('refuses symlinks on the way and skips them inside a copied tree', () => {
    const { ops } = setup();
    let linked = true;
    try {
      fs.symlinkSync(outside, path.join(rootA, 'link'), 'junction');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(rootA, 'src', 'leak.txt'));
    } catch {
      linked = false; // Windows without symlink rights: nothing to test here.
    }
    if (!linked) return;
    expect(codeOf(() => ops.create('a', 'link', 'x', 'file'))).toBe('NOT_FOUND');
    expect(codeOf(() => ops.rename('a', 'link/secret.txt', 'x'))).toBe('NOT_FOUND');
    expect(codeOf(() => ops.transfer('copy', { folderId: 'a', relPath: 'link' }, { folderId: 'b', relPath: '' }))).toBe('NOT_FOUND');
    expect(codeOf(() => ops.transfer('copy', { folderId: 'a', relPath: 'notes.txt' }, { folderId: 'a', relPath: 'link' }))).toBe(
      'NOT_FOUND',
    );
    ops.transfer('copy', { folderId: 'a', relPath: 'src' }, { folderId: 'b', relPath: '' });
    expect(fs.readdirSync(path.join(rootB, 'src'))).toEqual(['main.ts']);
  });

  it('refuses hidden entries as source, destination, or path segment', () => {
    const { ops } = setup();
    write(path.join(rootA, '.git', 'config'));
    expect(codeOf(() => ops.transfer('copy', { folderId: 'a', relPath: '.git' }, { folderId: 'b', relPath: '' }))).toBe('NOT_FOUND');
    expect(codeOf(() => ops.create('a', '.git', 'x', 'file'))).toBe('NOT_FOUND');
    expect(codeOf(() => ops.rename('a', 'notes.txt', '.DS_Store'))).toBe('INVALID_PARAMS');
  });

  it('writes nothing when a copy exceeds the entry cap', () => {
    const { ops } = setup();
    const big = path.join(rootA, 'big');
    fs.mkdirSync(big);
    for (let i = 0; i < WORKBENCH_LIMITS.copyEntries; i += 1) fs.writeFileSync(path.join(big, `f${i}`), '');
    expect(codeOf(() => ops.transfer('copy', { folderId: 'a', relPath: 'big' }, { folderId: 'b', relPath: '' }))).toBe(
      'PRECONDITION_FAILED',
    );
    expect(fs.readdirSync(rootB)).toEqual([]);
  });

  it('imports dropped paths only after the confirmation, without overwriting', async () => {
    const { ops, confirmImport } = setup();
    write(path.join(rootB, 'secret.txt'), 'mine');
    const src = path.join(outside, 'secret.txt');
    expect(await ops.importPaths('b', '', [src, outside])).toEqual(['secret copy.txt', 'outside']);
    expect(confirmImport).toHaveBeenCalledWith({ folderName: 'B', relPath: '', paths: [src, outside] });
    expect(fs.readFileSync(path.join(rootB, 'secret.txt'), 'utf8')).toBe('mine');
    expect(fs.readFileSync(path.join(rootB, 'outside', 'secret.txt'), 'utf8')).toBe('secret');

    confirmImport.mockResolvedValueOnce(false);
    expect(await ops.importPaths('a', '', [src])).toEqual([]);
    expect(fs.existsSync(path.join(rootA, 'secret.txt'))).toBe(false);

    expect(await codeOfAsync(ops.importPaths('a', '', ['relative/path']))).toBe('INVALID_PARAMS');
    expect(await codeOfAsync(ops.importPaths('a', '', [path.join(outside, 'missing')]))).toBe('NOT_FOUND');
    // A granted folder dropped into its own subtree.
    expect(await codeOfAsync(ops.importPaths('a', 'src', [rootA]))).toBe('INVALID_PARAMS');
    expect(confirmImport).toHaveBeenCalledTimes(2);
  });

  it('copies the absolute or the relative path to the clipboard', () => {
    const { ops, writeClipboard } = setup();
    ops.copyPath('a', 'src/main.ts', false);
    expect(writeClipboard).toHaveBeenLastCalledWith(path.join(rootA, 'src', 'main.ts'));
    ops.copyPath('a', 'src/main.ts', true);
    expect(writeClipboard).toHaveBeenLastCalledWith(path.join('src', 'main.ts'));
    expect(codeOf(() => ops.copyPath('a', 'nope', true))).toBe('NOT_FOUND');
  });
});

describe('buildFolderImportConfirm', () => {
  it('localizes the confirmation and lists the paths', () => {
    const c = buildFolderImportConfirm('zh-CN', { folderName: 'app', relPath: 'src', paths: ['/x/a', '/x/b'] });
    expect(c.message).toContain('2');
    expect(c.message).toContain('app/src');
    expect(c.detail).toBe('/x/a\n/x/b');
    expect(c.confirm).toBe('复制');
    const many = buildFolderImportConfirm('en', { folderName: 'app', relPath: '', paths: Array.from({ length: 25 }, (_, i) => `/p${i}`) });
    expect(many.detail.split('\n')).toHaveLength(21);
  });
});
