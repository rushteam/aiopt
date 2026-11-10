import { describe, expect, it } from 'vitest';
import {
  collapsedHead,
  DraftBlocks,
  insertAt,
  isLargePaste,
  LARGE_PASTE_CHARS,
  normalizePaste,
  repairMarkers,
  snapSelection,
  splitFences,
} from '../draftBlocks';

describe('draftBlocks', () => {
  it('treats more than 10 lines or 1000 characters as a large paste', () => {
    expect(isLargePaste('a\n'.repeat(9) + 'a')).toBe(false); // 10 lines
    expect(isLargePaste('a\n'.repeat(10) + 'a')).toBe(true); // 11 lines
    expect(isLargePaste('x'.repeat(LARGE_PASTE_CHARS))).toBe(false);
    expect(isLargePaste('x'.repeat(LARGE_PASTE_CHARS + 1))).toBe(true);
    expect(normalizePaste('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('expands live markers in one pass and skips edited ones', () => {
    const store = new DraftBlocks();
    const m1 = store.add('first [paste #2]', `paste #${store.nextPasteId()}`);
    const m2 = store.add('second', `paste #${store.nextPasteId()}`);
    expect([m1, m2]).toEqual(['[paste #1]', '[paste #2]']);
    // A block's own text that looks like a marker is not expanded again.
    expect(store.expand(`a ${m1} b ${m2}`)).toBe('a first [paste #2] b second');
    expect(store.expand('a [paste #1 edited]')).toBe('a [paste #1 edited]');
    expect(store.liveCount(`x ${m2}`)).toBe(1);
    store.clear();
    expect(store.expand(m1)).toBe(m1);
    expect(store.nextPasteId()).toBe(1);
  });

  it('puts an own-lines block on lines of its own', () => {
    const store = new DraftBlocks();
    const m = store.add('@a/b.ts:1-2\n```ts\nx\n```', 'quote', true);
    expect(store.expand(`see ${m} please`)).toBe('see \n@a/b.ts:1-2\n```ts\nx\n```\n please');
    expect(store.expand(`${m}\nok`)).toBe('@a/b.ts:1-2\n```ts\nx\n```\nok');
    expect(store.markerFor('@a/b.ts:1-2\n```ts\nx\n```', `hi ${m}`)).toBe(m);
    expect(store.markerFor('@a/b.ts:1-2\n```ts\nx\n```', 'hi')).toBeNull();
  });

  it('finds a whole marker next to the caret', () => {
    const store = new DraftBlocks();
    const m = store.add('text', 'paste #1');
    const draft = `ab ${m} cd`;
    expect(store.markerAt(draft, 3 + m.length, 'before')).toEqual({ start: 3, end: 3 + m.length });
    expect(store.markerAt(draft, 3, 'after')).toEqual({ start: 3, end: 3 + m.length });
    expect(store.markerAt(draft, 2, 'before')).toBeNull();
  });

  it('inserts with spaces where it would touch a word', () => {
    expect(insertAt('abcd', 2, 2, '[m]')).toEqual({ text: 'ab [m] cd', caret: 7 });
    expect(insertAt('', 0, 0, '[m]')).toEqual({ text: '[m]', caret: 3 });
    expect(insertAt('a xx b', 2, 4, '[m]')).toEqual({ text: 'a [m] b', caret: 5 });
  });

  it('splits a message into text and fenced code', () => {
    expect(splitFences('see\n@a/b.ts:1-2\n````ts\nx\n```\n````\nthanks')).toEqual([
      { kind: 'text', text: 'see\n@a/b.ts:1-2' },
      { kind: 'code', lang: 'ts', text: 'x\n```' },
      { kind: 'text', text: 'thanks' },
    ]);
    expect(splitFences('```\nopen')).toEqual([{ kind: 'code', lang: '', text: 'open' }]);
    expect(splitFences('plain `code` text')).toEqual([{ kind: 'text', text: 'plain `code` text' }]);
  });

  it('cuts long blocks to a head', () => {
    expect(collapsedHead('a\nb', 2, 100)).toBeNull();
    // A couple of extra lines are not worth a toggle.
    expect(collapsedHead('1\n2\n3\n4', 2, 100)).toBeNull();
    expect(collapsedHead('1\n2\n3\n4\n5', 2, 100)).toEqual({ head: '1\n2', lines: 5 });
    expect(collapsedHead('word '.repeat(100), 5, 20)?.head).toBe('word word word word');
  });
});

describe('repairMarkers', () => {
  const M = '[粘贴 #1 · 24 行]';
  const draft = `看下 ${M} 谢谢`;
  const spans = [{ start: 3, end: 3 + M.length }];

  it('ignores edits that do not touch a marker', () => {
    expect(repairMarkers(draft, `${draft}!`, spans)).toBeNull();
    expect(repairMarkers(draft, draft.slice(1), spans)).toBeNull();
    expect(repairMarkers(draft, draft, spans)).toBeNull();
  });

  it('removes the whole marker when part of it is deleted', () => {
    // Backspace from inside the marker (one char before its end).
    const next = draft.slice(0, 3 + M.length - 2) + draft.slice(3 + M.length - 1);
    expect(repairMarkers(draft, next, spans)).toEqual({ text: '看下  谢谢', caret: 3 });
  });

  it('removes the whole marker when a selection covers half of it', () => {
    const next = '看' + draft.slice(8);
    expect(repairMarkers(draft, next, spans)).toEqual({ text: '看 谢谢', caret: 1 });
  });

  it('replaces the whole marker when typing over part of it', () => {
    const next = draft.slice(0, 5) + 'X' + draft.slice(7);
    expect(repairMarkers(draft, next, spans)).toEqual({ text: '看下 X 谢谢', caret: 4 });
  });

  it('moves text typed inside a marker to after it', () => {
    const next = draft.slice(0, 6) + 'ab' + draft.slice(6);
    expect(repairMarkers(draft, next, spans)).toEqual({ text: `看下 ${M}ab 谢谢`, caret: 3 + M.length + 2 });
  });

  it('leaves a fully deleted marker alone', () => {
    expect(repairMarkers(draft, '看下  谢谢', spans)).toBeNull();
  });
});

describe('snapSelection', () => {
  const spans = [{ start: 3, end: 13 }];
  it('moves a caret inside a marker to the nearer edge', () => {
    expect(snapSelection(4, 4, spans)).toEqual({ start: 3, end: 3 });
    expect(snapSelection(11, 11, spans)).toEqual({ start: 13, end: 13 });
  });
  it('grows a range that cuts into a marker', () => {
    expect(snapSelection(1, 5, spans)).toEqual({ start: 1, end: 13 });
    expect(snapSelection(6, 15, spans)).toEqual({ start: 3, end: 15 });
  });
  it('leaves edges and outside positions alone', () => {
    expect(snapSelection(3, 3, spans)).toBeNull();
    expect(snapSelection(13, 13, spans)).toBeNull();
    expect(snapSelection(0, 20, spans)).toBeNull();
  });
});

describe('DraftBlocks.spans', () => {
  it('lists every live marker in text order', () => {
    const store = new DraftBlocks();
    const a = store.add('x'.repeat(2000), 'A');
    const b = store.add('y'.repeat(2000), 'B');
    expect(store.spans(`${b} ${a}`)).toEqual([
      { start: 0, end: b.length },
      { start: b.length + 1, end: b.length + 1 + a.length },
    ]);
  });
});
