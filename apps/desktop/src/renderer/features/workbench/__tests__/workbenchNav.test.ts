import { describe, expect, it } from 'vitest';
import { MAX_NAV_DEPTH, appendMention, folderMentionText, formatBytes, lineNumbers, sidebarTaskOrder, viewKey } from '../workbenchNav';
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

  it('keys views stably', () => {
    expect(viewKey({ kind: 'chat' })).toBe('chat');
    expect(viewKey({ kind: 'task', id: 'abc' })).toBe('task:abc');
  });
});
