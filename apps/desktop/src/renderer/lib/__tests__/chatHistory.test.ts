import { describe, expect, it } from 'vitest';
import { EMPTY_CHAT_HISTORY, mergeChatWindow, prependChatPage, sameChatItem } from '../chatHistory';
import { WORKBENCH_LIMITS, type ChatItem } from '../../../shared/workbench';

const err = (n: number): ChatItem => ({ kind: 'error', id: `c${n}`, message: `m${n}` });
const range = (from: number, to: number): ChatItem[] => Array.from({ length: to - from }, (_, i) => err(from + i));

describe('chatHistory', () => {
  it('starts from the first window', () => {
    const h = mergeChatWindow(EMPTY_CHAT_HISTORY, range(60, 100), true, 1);
    expect(h.items).toHaveLength(40);
    expect(h.hasMore).toBe(true);
    expect(h.epoch).toBe(1);
  });

  it('keeps unchanged items by identity and replaces only the changed one', () => {
    const a = mergeChatWindow(EMPTY_CHAT_HISTORY, [err(1), { kind: 'assistant', id: 'c2', text: 'h', thinking: '', streaming: true }], false, 1);
    const b = mergeChatWindow(a, [err(1), { kind: 'assistant', id: 'c2', text: 'hi', thinking: '', streaming: true }], false, 1);
    expect(b.items[0]).toBe(a.items[0]);
    expect(b.items[1]).not.toBe(a.items[1]);
    expect(mergeChatWindow(b, [err(1), { ...(b.items[1] as ChatItem) }], false, 1)).toBe(b);
  });

  it('keeps paged-in history while the window slides forward', () => {
    let h = mergeChatWindow(EMPTY_CHAT_HISTORY, range(60, 100), true, 1);
    h = prependChatPage(h, 'c60', { items: range(20, 60), hasMore: true, epoch: 1 });
    expect(h.items).toHaveLength(80);
    expect(h.items[0]!.id).toBe('c20');
    const older = h.items[0];
    h = mergeChatWindow(h, range(61, 101), true, 1);
    expect(h.items).toHaveLength(81);
    expect(h.items[0]).toBe(older);
    expect(h.hasMore).toBe(true);
    expect(h.items.at(-1)!.id).toBe('c100');
  });

  it('starts over on a new epoch or when the window no longer overlaps', () => {
    let h = mergeChatWindow(EMPTY_CHAT_HISTORY, range(60, 100), true, 1);
    h = prependChatPage(h, 'c60', { items: range(20, 60), hasMore: false, epoch: 1 });
    expect(mergeChatWindow(h, range(0, 3), false, 2).items).toHaveLength(3);
    expect(mergeChatWindow(h, range(200, 240), true, 1).items[0]!.id).toBe('c200');
  });

  it('drops a stale page', () => {
    const h = mergeChatWindow(EMPTY_CHAT_HISTORY, range(60, 100), true, 1);
    expect(prependChatPage(h, 'c60', { items: range(20, 60), hasMore: true, epoch: 2 })).toBe(h);
    expect(prependChatPage(h, 'c61', { items: range(20, 60), hasMore: true, epoch: 1 })).toBe(h);
  });

  it('caps the merged view at the newest chatItems', () => {
    const max = WORKBENCH_LIMITS.chatItems;
    let h = mergeChatWindow(EMPTY_CHAT_HISTORY, range(max, max + 40), true, 1);
    h = prependChatPage(h, `c${max}`, { items: range(0, max), hasMore: false, epoch: 1 });
    h = mergeChatWindow(h, range(max + 1, max + 41), true, 1);
    expect(h.items).toHaveLength(max);
    expect(h.items.at(-1)!.id).toBe(`c${max + 40}`);
    expect(h.hasMore).toBe(true);
  });

  it('compares arrays by value', () => {
    expect(sameChatItem({ kind: 'proposal', id: 'p', taskIds: ['a'] }, { kind: 'proposal', id: 'p', taskIds: ['a'] })).toBe(true);
    expect(sameChatItem({ kind: 'proposal', id: 'p', taskIds: ['a'] }, { kind: 'proposal', id: 'p', taskIds: ['b'] })).toBe(false);
  });
});
