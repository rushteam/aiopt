import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readUtf8WithoutBom, writeFileAtomicSync } from '../storeFile';

// secretStore and configStore commit through the writer, and every userData store reads through the
// BOM-stripping reader. The failure case is simulated by making the rename throw: that is the
// point where an in-place write would already have destroyed the old file, and the property under
// test is that the old file survives.

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-storefile-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('writeFileAtomicSync', () => {
  it('creates the parent directory and writes text or bytes', () => {
    const text = path.join(root, 'nested', 'a.json');
    writeFileAtomicSync(text, '{"a":1}\n');
    expect(fs.readFileSync(text, 'utf8')).toBe('{"a":1}\n');

    const bytes = path.join(root, 'b.enc');
    writeFileAtomicSync(bytes, Buffer.from([0, 1, 2, 255]));
    expect([...fs.readFileSync(bytes)]).toEqual([0, 1, 2, 255]);
  });

  it('replaces an existing file and leaves no temp file behind', () => {
    const file = path.join(root, 'a.json');
    fs.writeFileSync(file, 'old');
    writeFileAtomicSync(file, 'new');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.readdirSync(root)).toEqual(['a.json']);
  });

  it('keeps the previous file intact and removes the temp when the commit fails', () => {
    const file = path.join(root, 'a.json');
    fs.writeFileSync(file, 'old');
    const enospc = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw enospc;
    });
    expect(() => writeFileAtomicSync(file, 'new')).toThrow(enospc);
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    expect(fs.readdirSync(root)).toEqual(['a.json']);
  });
});

describe('readUtf8WithoutBom', () => {
  it('strips exactly one leading BOM and leaves other text alone', () => {
    const file = path.join(root, 'a.json');
    fs.writeFileSync(file, '\uFEFF{"a":1}');
    expect(readUtf8WithoutBom(file)).toBe('{"a":1}');
    fs.writeFileSync(file, 'x\uFEFFy');
    expect(readUtf8WithoutBom(file)).toBe('x\uFEFFy');
  });

  it('throws for a missing file, as readFileSync does', () => {
    expect(() => readUtf8WithoutBom(path.join(root, 'nope'))).toThrow(/ENOENT/);
  });
});
