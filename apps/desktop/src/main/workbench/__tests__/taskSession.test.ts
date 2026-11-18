import { describe, expect, it } from 'vitest';
import { displayUserText, newestSessionFile, parseTaskSession } from '../taskSession';

const msg = (message: Record<string, unknown>) => JSON.stringify({ type: 'message', message });

describe('newestSessionFile', () => {
  it('picks the newest regular .jsonl file', () => {
    expect(
      newestSessionFile([
        { name: 'a.jsonl', kind: 'file', mtimeMs: 1 },
        { name: 'b.jsonl', kind: 'file', mtimeMs: 3 },
        { name: 'c.jsonl', kind: 'other', mtimeMs: 9 },
        { name: 'd.txt', kind: 'file', mtimeMs: 9 },
      ]),
    ).toBe('b.jsonl');
    expect(newestSessionFile([{ name: 'x', kind: 'dir', mtimeMs: 1 }])).toBeNull();
    // Same mtime: the later file name (pi names files by start time).
    expect(
      newestSessionFile([
        { name: '2026-01-02_b.jsonl', kind: 'file', mtimeMs: 5 },
        { name: '2026-01-01_a.jsonl', kind: 'file', mtimeMs: 5 },
      ]),
    ).toBe('2026-01-02_b.jsonl');
  });
});

describe('displayUserText', () => {
  it('shows an expanded skill as the command that was sent', () => {
    const block =
      '<skill name="echo" location="/s/echo/SKILL.md">\nReferences are relative to /s/echo.\n\nbody\n</skill>';
    expect(displayUserText(`${block}\n\nbanana`)).toBe('/skill:echo banana');
    expect(displayUserText(block)).toBe('/skill:echo');
  });

  it('drops the word put before a prompt that would read as a pi command', () => {
    expect(displayUserText('Message: /login')).toBe('/login');
    expect(displayUserText('Message: hello')).toBe('Message: hello');
  });
});

describe('parseTaskSession', () => {
  it('turns message records into chat items, with tool results joined to their call', () => {
    const text = [
      JSON.stringify({ type: 'session', cwd: '/w' }),
      msg({ role: 'system', content: 'sys' }),
      msg({ role: 'user', content: [{ type: 'text', text: 'fix it' }] }),
      msg({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Looking' },
          { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
        ],
      }),
      msg({ role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'a.ts' }] }),
      'not json',
      msg({ role: 'assistant', content: [{ type: 'text', text: 'Done' }] }),
    ].join('\n');
    const items = parseTaskSession(text, false);
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(items[1]).toMatchObject({ text: 'Looking', thinking: 'hmm', streaming: false });
    expect(items[2]).toMatchObject({ name: 'bash', result: 'a.ts', done: true, isError: false });
  });

  it('drops the cut first line of a tail read', () => {
    const text = `ole":"user","content":"cut"}}\n${msg({ role: 'user', content: 'kept' })}`;
    expect(parseTaskSession(text, true).map((i) => (i.kind === 'user' ? i.text : ''))).toEqual(['kept']);
  });
});
