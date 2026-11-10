import { describe, expect, it } from 'vitest';
import { fileMentionDir, fileMentionOptions } from '../fileMention';
import { parseEntryDrag } from '../entryDrag';
import type { FolderEntry } from '../../../../shared/workbench';

const folders = [
  { id: 'f1', name: 'app' },
  { id: 'f2', name: 'my docs' },
];
const tree: Record<string, FolderEntry[]> = {
  'f1:': [
    { name: 'src', kind: 'dir' },
    { name: 'README.md', kind: 'file' },
    { name: 'package.json', kind: 'file' },
  ],
  'f1:src': [
    { name: 'main.ts', kind: 'file' },
    { name: 'domain.ts', kind: 'file' },
  ],
};
const listing = (id: string, rel: string) => tree[`${id}:${rel}`];
const opts = (q: string) => fileMentionOptions(q, folders, listing, 'Folder');

describe('fileMentionDir', () => {
  it('splits a path query into folder, directory and partial name', () => {
    expect(fileMentionDir('app/src/ma', folders)).toEqual({ folder: folders[0], dirRel: 'src', partial: 'ma' });
    expect(fileMentionDir('app/', folders)).toEqual({ folder: folders[0], dirRel: '', partial: '' });
    expect(fileMentionDir('my docs/a', folders)?.folder.id).toBe('f2');
  });

  it('is null without a folder or with dot segments', () => {
    expect(fileMentionDir('ap', folders)).toBeNull();
    expect(fileMentionDir('app/../x', folders)).toBeNull();
  });
});

describe('fileMentionOptions', () => {
  it('offers matching folders to browse into', () => {
    expect(opts('ap')).toEqual([expect.objectContaining({ token: '@app/', browse: true, kind: 'dir' })]);
    expect(opts('')).toHaveLength(2);
  });

  it('lists a directory, prefix matches first', () => {
    const o = opts('app/src/ma');
    expect(o.map((x) => x.token)).toEqual(['@app/src/main.ts', '@app/src/domain.ts']);
  });

  it('browses into subdirectories and offers the directory itself', () => {
    expect(opts('app/').find((x) => x.label === 'src/')).toMatchObject({ token: '@app/src/', browse: true });
    expect(opts('app/src/')[0]).toMatchObject({ token: '@app/src', label: 'src/' });
    expect(opts('app/src/')[0]!.browse).toBeUndefined();
  });

  it('backticks a file reference with whitespace and waits for an unloaded listing', () => {
    const o = fileMentionOptions('my docs/', folders, () => [{ name: 'a b.md', kind: 'file' }], 'Folder');
    expect(o[0]!.token).toBe('`@my docs/a b.md`');
    expect(fileMentionOptions('app/lib/', folders, () => undefined, 'Folder')).toHaveLength(1);
  });
});

describe('parseEntryDrag', () => {
  it('reads a well-formed payload only', () => {
    expect(parseEntryDrag('{"folderId":"f1","relPath":"src/a.ts"}')).toEqual({ folderId: 'f1', relPath: 'src/a.ts' });
    expect(parseEntryDrag('{"folderId":"f1","relPath":"../x"}')).toBeNull();
    expect(parseEntryDrag('{"folderId":1,"relPath":"a"}')).toBeNull();
    expect(parseEntryDrag('nope')).toBeNull();
    expect(parseEntryDrag('')).toBeNull();
  });
});
