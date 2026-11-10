import { describe, expect, it } from 'vitest';
import { codeSource, findFileRefs, findPathRefs, parseFileRef } from '../fileRefs';
import { splitFences } from '../draftBlocks';
import { lineQuoteText } from '../workbenchNav';

const folders = [
  { id: 'f1', name: 'app' },
  { id: 'f2', name: 'my docs' },
];

describe('parseFileRef', () => {
  it('resolves a reference to folder id + relative path', () => {
    expect(parseFileRef('@app/src/a.ts', folders)).toEqual({ folderId: 'f1', relPath: 'src/a.ts' });
  });

  it('reads a line or a line range', () => {
    expect(parseFileRef('@app/a.ts:7', folders)).toEqual({
      folderId: 'f1',
      relPath: 'a.ts',
      range: { start: 7, end: 7 },
    });
    expect(parseFileRef('@app/a.ts:3-8', folders)?.range).toEqual({ start: 3, end: 8 });
  });

  it('reads a backticked reference with spaces', () => {
    expect(parseFileRef('`@my docs/read me.md:2-4`', folders)).toEqual({
      folderId: 'f2',
      relPath: 'read me.md',
      range: { start: 2, end: 4 },
    });
  });

  it('refuses unknown folders, empty paths and dot segments', () => {
    expect(parseFileRef('@other/a.ts', folders)).toBeNull();
    expect(parseFileRef('@app/', folders)).toBeNull();
    expect(parseFileRef('@app/../secret', folders)).toBeNull();
    expect(parseFileRef('@app/a/./b', folders)).toBeNull();
    expect(parseFileRef('app/a.ts', folders)).toBeNull();
  });

  it('prefers the longest matching folder name', () => {
    const nested = [...folders, { id: 'f3', name: 'app/web' }];
    expect(parseFileRef('@app/web/x.ts', nested)?.folderId).toBe('f3');
  });

  it('drops a reversed range but keeps the file', () => {
    expect(parseFileRef('@app/a.ts:9-3', folders)).toEqual({ folderId: 'f1', relPath: 'a.ts' });
  });
});

describe('findFileRefs', () => {
  it('finds references in prose, without trailing punctuation', () => {
    const text = 'see @app/a.ts:3, then `@my docs/b.md`.';
    const refs = findFileRefs(text, folders);
    expect(refs.map((r) => text.slice(r.index, r.index + r.length))).toEqual(['@app/a.ts:3', '`@my docs/b.md`']);
  });

  it('skips e-mail-like tokens and unknown folders', () => {
    expect(findFileRefs('mail me@app/a.ts or @nope/x', folders)).toEqual([]);
  });
});

describe('codeSource', () => {
  it('names the file a quoted line range came from', () => {
    const msg = `look\n${lineQuoteText('app', 'src/a.ts', { start: 3, end: 4 }, 'x\ny')}\nwhy?`;
    const segments = splitFences(msg);
    const i = segments.findIndex((s) => s.kind === 'code');
    expect(codeSource(segments, i, folders)).toEqual({
      folderId: 'f1',
      relPath: 'src/a.ts',
      range: { start: 3, end: 4 },
    });
  });

  it('is null for a code block with no reference before it', () => {
    const segments = splitFences('hi\n```js\nx\n```');
    expect(codeSource(segments, 1, folders)).toBeNull();
    expect(codeSource(splitFences('```\nx\n```'), 0, folders)).toBeNull();
  });
});

describe('findPathRefs', () => {
  const fs = [
    { id: 'f1', name: 'test', displayPath: '~/Documents/test' },
    { id: 'f2', name: 'web', displayPath: '/srv/web' },
  ];
  const plain = (text: string) =>
    findPathRefs(text, fs).map((r) => ({ s: text.slice(r.index, r.index + r.length), e: r.explicit, t: r.targets }));

  it('maps absolute paths through the display path', () => {
    expect(plain('wrote /Users/alice/Documents/test/a/b.py:3 ok')).toEqual([
      {
        s: '/Users/alice/Documents/test/a/b.py:3',
        e: false,
        t: [{ folderId: 'f1', relPath: 'a/b.py', range: { start: 3, end: 3 } }],
      },
    ]);
    expect(plain('~/Documents/test/x.md')[0]!.t).toEqual([{ folderId: 'f1', relPath: 'x.md' }]);
    expect(plain('/srv/web/index.html')[0]!.t).toEqual([{ folderId: 'f2', relPath: 'index.html' }]);
    expect(plain('/etc/passwd')).toEqual([]);
    expect(plain('/opt/x/Documents/test/a.py')).toEqual([]);
  });

  it('offers relative paths in every folder, a leading folder name first', () => {
    expect(plain('see `test/pascal.py`')[0]!.t).toEqual([
      { folderId: 'f1', relPath: 'pascal.py' },
      { folderId: 'f1', relPath: 'test/pascal.py' },
      { folderId: 'f2', relPath: 'test/pascal.py' },
    ]);
    expect(plain('已创建pascal_triangle.py。')).toEqual([
      expect.objectContaining({ s: 'pascal_triangle.py', e: false }),
    ]);
    expect(plain('src/a.ts#L4-L9')[0]!.t[0]).toEqual({
      folderId: 'f1',
      relPath: 'src/a.ts',
      range: { start: 4, end: 9 },
    });
  });

  it('skips words, versions, URLs and dot segments; keeps explicit refs', () => {
    expect(plain('v1.0.35 https://x.io/a.js ../x.py and/ or')).toEqual([]);
    expect(plain('@test/a.py and b.py')).toEqual([
      { s: '@test/a.py', e: true, t: [{ folderId: 'f1', relPath: 'a.py' }] },
      expect.objectContaining({ s: 'b.py', e: false }),
    ]);
  });
});
