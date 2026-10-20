// The coordinator chat as the renderer holds it: the newest window every snapshot carries,
// plus older pages fetched on demand (scrolling to the top), merged into one id-ordered list.
//
// Pure. Unchanged items keep their object identity across merges, so a memoized row
// re-renders only when its own content changed — during a streamed reply, just the reply.

import { WORKBENCH_LIMITS, type ChatItem } from '../../shared/workbench';

export interface ChatHistory {
  items: ChatItem[];
  /** Older items exist before `items[0]` in main. */
  hasMore: boolean;
  epoch: number;
}

export const EMPTY_CHAT_HISTORY: ChatHistory = { items: [], hasMore: false, epoch: -1 };

function sameArray(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

/** Field-by-field equality (arrays by value): whether `next` can reuse `prev`'s object. */
export function sameChatItem(prev: ChatItem, next: ChatItem): boolean {
  if (prev === next) return true;
  if (prev.kind !== next.kind || prev.id !== next.id) return false;
  const a = prev as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length !== Object.keys(a).length) return false;
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (!sameArray(x, y)) return false;
    } else if (x !== y) return false;
  }
  return true;
}

function capped(items: ChatItem[], hasMore: boolean): { items: ChatItem[]; hasMore: boolean } {
  const max = WORKBENCH_LIMITS.chatItems;
  return items.length > max ? { items: items.slice(-max), hasMore: true } : { items, hasMore };
}

/**
 * Fold a snapshot's newest window into the history. Older items already loaded stay when the
 * window still overlaps them; a new epoch (conversation switched / reset) or a gap starts over.
 */
export function mergeChatWindow(
  prev: ChatHistory,
  window: readonly ChatItem[],
  windowHasMore: boolean,
  epoch: number,
): ChatHistory {
  if (epoch !== prev.epoch || prev.items.length === 0 || window.length === 0) {
    return { items: [...window], hasMore: windowHasMore, epoch };
  }
  const start = prev.items.findIndex((item) => item.id === window[0]!.id);
  if (start < 0) return { items: [...window], hasMore: windowHasMore, epoch };

  const byId = new Map(prev.items.slice(start).map((item) => [item.id, item]));
  const head = prev.items.slice(0, start);
  const tail = window.map((next) => {
    const old = byId.get(next.id);
    return old && sameChatItem(old, next) ? old : next;
  });
  // Nothing before the window was loaded: main's flag is the truth.
  const merged = capped([...head, ...tail], head.length > 0 ? prev.hasMore : windowHasMore);
  const unchanged =
    merged.items.length === prev.items.length && merged.items.every((item, i) => item === prev.items[i]);
  if (unchanged && merged.hasMore === prev.hasMore) return prev;
  return { ...merged, epoch };
}

/**
 * Prepend an older page fetched before `beforeId`. Dropped when stale: another epoch, or the
 * list no longer starts at the item it was fetched for.
 */
export function prependChatPage(
  prev: ChatHistory,
  beforeId: string,
  page: { items: readonly ChatItem[]; hasMore: boolean; epoch: number },
): ChatHistory {
  if (page.epoch !== prev.epoch || prev.items[0]?.id !== beforeId) return prev;
  const seen = new Set(prev.items.map((item) => item.id));
  const older = page.items.filter((item) => !seen.has(item.id));
  // Pages come from main's own capped transcript, so this stays bounded; the next window merge
  // re-applies the cap.
  return { items: [...older, ...prev.items], hasMore: page.hasMore, epoch: prev.epoch };
}
