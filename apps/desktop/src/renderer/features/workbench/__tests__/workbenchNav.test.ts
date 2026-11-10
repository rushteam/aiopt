import { describe, expect, it } from 'vitest';
import {
  MAX_NAV_DEPTH,
  appendMention,
  lineQuoteText,
  QUOTE_EXCERPT_CHARS,
  sliceLines,
  folderMentionText,
  formatBytes,
  lineNumbers,
  searchConversations,
  searchTasks,
  sidebarTaskOrder,
  viewKey,
} from '../workbenchNav';
import type { TaskView } from '../../../../shared/workbench';

function task(id: string, dependsOn: string[] = []): TaskView {
  return { id, title: id, dependsOn } as unknown as TaskView;
}

describe('workbenchNav', () => {
  it('keys a file view by folder and path, distinct from the tabs', () => {
    expect(viewKey({ kind: 'file', folderId: 'f1', relPath: 'a/b.ts' })).toBe('file:f1\u0000a/b.ts');
    expect(viewKey({ kind: 'file', folderId: 'f1', relPath: 'a' })).not.toBe(viewKey({ kind: 'file', folderId: 'f2', relPath: 'a' }));
  });

  it('numbers preview lines, a trailing newline adding none', () => {
    expect(lineNumbers('')).toBe('1');
    expect(lineNumbers('a')).toBe('1');
    expect(lineNumbers('a\nb\n')).toBe('1\n2');
    expect(lineNumbers('a\n\nb')).toBe('1\n2\n3');
  });

  it('formats byte counts', () => {
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(12_700)).toBe('12.4 KB');
    expect(formatBytes(3.1 * 1024 * 1024)).toBe('3.1 MB');
  });

  it('orders a plan by dependency layer with bounded indent', () => {
    const tasks = [task('d', ['c']), task('a'), task('c', ['b']), task('b', ['a']), task('e', ['d']), task('x')];
    const order = sidebarTaskOrder(tasks);
    expect(order.map((o) => o.task.id)).toEqual(['a', 'x', 'b', 'c', 'd', 'e']);
    expect(order.find((o) => o.task.id === 'b')?.depth).toBe(1);
    expect(order.find((o) => o.task.id === 'e')?.depth).toBe(MAX_NAV_DEPTH);
    expect(sidebarTaskOrder([])).toEqual([]);
  });

  it('builds a file reference and appends it once within the cap', () => {
    expect(folderMentionText('app', 'src/main.ts')).toBe('@app/src/main.ts');
    expect(folderMentionText('my app', 'a.ts')).toBe('`@my app/a.ts`');
    expect(appendMention('', '@app/a.ts', 100)).toBe('@app/a.ts ');
    expect(appendMention('look at', '@app/a.ts', 100)).toBe('look at @app/a.ts ');
    expect(appendMention('look at @app/a.ts ', '@app/a.ts', 100)).toBe('look at @app/a.ts ');
    expect(appendMention('x'.repeat(95), '@app/a.ts', 100)).toBe('x'.repeat(95));
  });

  it('slices picked lines and quotes them with a safe fence', () => {
    expect(sliceLines('a\nb\nc\n', { start: 2, end: 3 })).toBe('b\nc');
    expect(sliceLines('a\nb', { start: 2, end: 9 })).toBe('b');
    expect(lineQuoteText('app', 'src/a.ts', { start: 3, end: 3 }, 'x')).toBe('@app/src/a.ts:3\n```ts\nx\n```');
    expect(lineQuoteText('app', 'README', { start: 1, end: 2 }, 'a\n```b')).toBe('@app/README:1-2\n````\na\n```b\n````');
    expect(lineQuoteText('my app', 'a.md', { start: 1, end: 2 }, '')).toBe('`@my app/a.md:1-2`');
    expect(lineQuoteText('app', 'a.ts', { start: 1, end: 2 }, 'x'.repeat(QUOTE_EXCERPT_CHARS + 1))).toBe('@app/a.ts:1-2');
  });

  it('keys views stably', () => {
    expect(viewKey({ kind: 'chat' })).toBe('chat');
    expect(viewKey({ kind: 'task', id: 'abc' })).toBe('task:abc');
  });

  it('finds tasks by every term across title, prompt, follow-ups and branch, newest first', () => {
    const mk = (id: string, over: Partial<TaskView>): TaskView =>
      ({ id, title: id, prompt: '', thread: [], branch: null, updatedAt: 0, dependsOn: [], ...over }) as TaskView;
    const tasks = [
      mk('a', { title: 'Fix login bug', updatedAt: 1 }),
      mk('b', { title: 'Refactor', prompt: 'Move the   login form\ninto its own component', updatedAt: 3 }),
      mk('c', { title: 'Docs', thread: [{ text: 'also update the LOGIN page', at: 1 }], updatedAt: 2 }),
      mk('d', { title: 'Infra', branch: 'aiopt/login-ci', updatedAt: 0 }),
    ];
    expect(searchTasks(tasks, '')).toEqual([]);
    expect(searchTasks(tasks, '   ')).toEqual([]);
    const hits = searchTasks(tasks, 'Login');
    expect(hits.map((h) => h.task.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(hits.map((h) => h.field)).toEqual(['prompt', 'thread', 'title', 'branch']);
    expect(hits[2]!.snippet).toBe('');
    expect(hits[0]!.snippet).toBe('Move the login form into its own component');
    expect(searchTasks(tasks, 'login component').map((h) => h.task.id)).toEqual(['b']);
    expect(searchTasks(tasks, 'login nope')).toEqual([]);
    const long = mk('e', { prompt: `${'x '.repeat(40)}needle ${'y '.repeat(60)}` });
    const snip = searchTasks([long], 'needle')[0]!.snippet;
    expect(snip.startsWith('…')).toBe(true);
    expect(snip.endsWith('…')).toBe(true);
    expect(snip).toContain('needle');
  });

  it('finds saved conversations by title', () => {
    const cs = [{ title: 'Ship the release notes' }, { title: 'Refactor the proxy' }, { title: '' }];
    expect(searchConversations(cs, 'the RELEASE')).toEqual([cs[0]]);
    expect(searchConversations(cs, '')).toEqual([]);
  });

  it('folds full-width and compatibility forms (NFKC) before matching', () => {
    const cs = [{ title: 'ＡＰＩ 设计 ① 版' }, { title: 'other' }];
    expect(searchConversations(cs, 'api')).toEqual([cs[0]]);
    expect(searchConversations(cs, 'ａｐｉ 1')).toEqual([cs[0]]);
  });
});
