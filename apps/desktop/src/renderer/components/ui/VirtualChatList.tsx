// A chat transcript list: variable-height virtualization, follow-the-latest, history paging.
//
// - Only rows overlapping the viewport ± OVERSCAN_SCREENS screens are mounted; the rest are two
//   spacers sized from measured heights (estimates until a row has rendered once).
// - It follows new content while the user is within FOLLOW_THRESHOLD_PX of the bottom; scrolling
//   up stops that and shows a "jump to latest" button.
// - Near the top it asks for older items (`onLoadMore`). The first visible row is the scroll
//   anchor: when rows are prepended or re-measured above it, the scroll position is corrected so
//   what the user is reading does not move.
// - Rows are memoized by item identity and `renderItem`, so a streamed reply re-renders only
//   itself (the store keeps unchanged items' identity; see renderer/lib/chatHistory.ts).

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEventHandler,
  type ReactNode,
} from 'react';
import { elevation, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { nextFollow, prefixOffsets, visibleRange } from '../../lib/virtualList';

/** Screens of rows kept mounted above and below the viewport. */
const OVERSCAN_SCREENS = 2;
/** Ask for older items once the viewport is this close to the top. */
const LOAD_MORE_PX = 240;

export interface VirtualChatListProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  /** Keep it stable (useCallback): a new function re-renders every mounted row. */
  renderItem: (item: T) => ReactNode;
  /** First-render height guess for a row (px, gap excluded), given the content width. */
  estimateHeight: (item: T, width: number) => number;
  hasMore?: boolean;
  onLoadMore?: () => Promise<void>;
  /** Changing this value jumps to the latest and resumes following (e.g. after sending). */
  followSignal?: unknown;
  empty?: ReactNode;
  /** Drawn after the last row (not virtualized). */
  footer?: ReactNode;
  jumpLabel: string;
  loadingLabel: string;
  gap?: number;
  padding?: number;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
}

interface RowProps {
  rowKey: string;
  item: unknown;
  render: (item: never) => ReactNode;
  gap: number;
  register: (key: string, el: HTMLDivElement | null) => void;
}

const Row = memo(
  function Row({ rowKey, item, render, gap, register }: RowProps) {
    const ref = useCallback((el: HTMLDivElement | null) => register(rowKey, el), [register, rowKey]);
    return (
      <div ref={ref} data-row-key={rowKey} style={{ paddingBottom: gap, display: 'flex', flexDirection: 'column' }}>
        {render(item as never)}
      </div>
    );
  },
  (a, b) => a.item === b.item && a.render === b.render && a.gap === b.gap && a.rowKey === b.rowKey,
);

export function VirtualChatList<T>({
  items,
  getKey,
  renderItem,
  estimateHeight,
  hasMore = false,
  onLoadMore,
  followSignal,
  empty,
  footer,
  jumpLabel,
  loadingLabel,
  gap = space.lg,
  padding = space.lg,
  onDragOver,
  onDrop,
}: VirtualChatListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const following = useRef(true);
  const lastTop = useRef(0);
  /** The row the user is reading and its offset from the viewport top. */
  const anchor = useRef<{ key: string; delta: number } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((n) => n + 1), []);
  const [loadingMore, setLoadingMore] = useState(false);
  const [atLatest, setAtLatest] = useState(true);
  /** A page that failed for this first row is not retried until the user scrolls again. */
  const failedFor = useRef<string | null>(null);

  // One observer for every mounted row: heights change as text streams in or <details> toggle.
  const observer = useRef<ResizeObserver | null>(null);
  if (observer.current === null && typeof ResizeObserver !== 'undefined') {
    observer.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target as HTMLDivElement;
        const key = el.dataset.rowKey;
        if (!key) continue;
        const h = el.offsetHeight;
        if (heights.current.get(key) !== h) {
          heights.current.set(key, h);
          changed = true;
        }
      }
      if (changed) rerender();
    });
  }
  useEffect(() => () => observer.current?.disconnect(), []);

  const register = useCallback((key: string, el: HTMLDivElement | null) => {
    const prev = rowEls.current.get(key);
    if (prev && prev !== el) observer.current?.unobserve(prev);
    if (el) {
      rowEls.current.set(key, el);
      observer.current?.observe(el);
    } else {
      rowEls.current.delete(key);
    }
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewport({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setViewport({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // --- layout -------------------------------------------------------------------------------
  const keys = items.map(getKey);
  const contentWidth = Math.max(0, viewport.width - 2 * padding);
  const rowHeights = items.map(
    (item, i) => heights.current.get(keys[i]!) ?? estimateHeight(item, contentWidth || 480) + gap,
  );
  const offsets = prefixOffsets(rowHeights);
  const total = offsets[offsets.length - 1]!;
  const viewHeight = viewport.height || 600;

  let top: number;
  if (following.current) {
    top = Math.max(0, total - viewHeight);
  } else {
    const a = anchor.current;
    const idx = a ? keys.indexOf(a.key) : -1;
    top = idx >= 0 ? Math.max(0, offsets[idx]! - a!.delta) : lastTop.current;
  }
  const { start, end } = visibleRange(offsets, top, viewHeight, viewHeight * OVERSCAN_SCREENS);
  const before = offsets[start] ?? 0;
  const after = total - (offsets[end] ?? total);

  // Drop measurements of rows no longer in the list.
  if (heights.current.size > items.length * 2 + 64) {
    const live = new Set(keys);
    for (const key of heights.current.keys()) if (!live.has(key)) heights.current.delete(key);
  }

  // --- scroll position ----------------------------------------------------------------------
  const captureAnchor = (el: HTMLDivElement): void => {
    const scrollTop = el.scrollTop;
    for (const key of keys.slice(start, end)) {
      const row = rowEls.current.get(key);
      if (row && row.offsetTop + row.offsetHeight > scrollTop) {
        anchor.current = { key, delta: row.offsetTop - scrollTop };
        return;
      }
    }
    anchor.current = null;
  };

  const setScrollTop = (el: HTMLDivElement, value: number): void => {
    el.scrollTop = value;
    lastTop.current = el.scrollTop;
  };

  // After every render: keep following, or keep the anchor row where it was.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (following.current) {
      if (el.scrollHeight - el.clientHeight - el.scrollTop > 1) setScrollTop(el, el.scrollHeight);
      return;
    }
    const a = anchor.current;
    const row = a ? rowEls.current.get(a.key) : undefined;
    if (a && row) {
      const want = row.offsetTop - a.delta;
      if (Math.abs(el.scrollTop - want) >= 1) setScrollTop(el, want);
    }
  });

  // A changed signal (the user sent a message) jumps to the latest.
  const firstSignal = useRef(true);
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false;
      return;
    }
    following.current = true;
    anchor.current = null;
    setAtLatest(true);
    rerender();
  }, [followSignal, rerender]);

  // --- history paging -----------------------------------------------------------------------
  const firstKey = keys[0] ?? null;
  const loadMore = useCallback(() => {
    if (!onLoadMore || loadingMore || !hasMore || firstKey === null || failedFor.current === firstKey) return;
    const el = scrollRef.current;
    if (el && following.current && el.scrollHeight > el.clientHeight) return;
    setLoadingMore(true);
    onLoadMore()
      .catch(() => {
        failedFor.current = firstKey;
      })
      .finally(() => setLoadingMore(false));
  }, [onLoadMore, loadingMore, hasMore, firstKey]);

  // A short page that doesn't fill the viewport can't be scrolled to the top: fetch more now.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && hasMore && el.scrollHeight <= el.clientHeight + LOAD_MORE_PX) loadMore();
  }, [hasMore, firstKey, viewport.height, loadMore]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const movedUp = el.scrollTop < lastTop.current - 1;
    lastTop.current = el.scrollTop;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    following.current = nextFollow({ distanceFromBottom: distance, movedUp, following: following.current });
    if (following.current) anchor.current = null;
    else captureAnchor(el);
    setAtLatest(following.current);
    if (el.scrollTop < LOAD_MORE_PX && movedUp) {
      failedFor.current = null;
      loadMore();
    }
    rerender();
  };

  const jumpToLatest = (): void => {
    const el = scrollRef.current;
    following.current = true;
    anchor.current = null;
    setAtLatest(true);
    if (el) setScrollTop(el, el.scrollHeight);
    rerender();
  };

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onDragOver={onDragOver}
        onDrop={onDrop}
        aria-live="polite"
        aria-busy={loadingMore || undefined}
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowAnchor: 'none',
          overscrollBehavior: 'contain',
          padding,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {items.length === 0 && !footer && empty}
        {loadingMore && (
          <p role="status" style={{ margin: 0, paddingBottom: gap, textAlign: 'center', fontSize: fontSize.sm, color: token('textMuted') }}>
            {loadingLabel}
          </p>
        )}
        {before > 0 && <div aria-hidden style={{ height: before, flexShrink: 0 }} />}
        {items.slice(start, end).map((item, i) => {
          const key = keys[start + i]!;
          return (
            <Row
              key={key}
              rowKey={key}
              item={item}
              render={renderItem as (item: never) => ReactNode}
              gap={gap}
              register={register}
            />
          );
        })}
        {after > 0 && <div aria-hidden style={{ height: after, flexShrink: 0 }} />}
        {footer}
      </div>
      {!atLatest && items.length > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          {...hoverBackground(token('surface'), token('surfaceHover'))}
          style={{
            all: 'unset',
            position: 'absolute',
            left: '50%',
            bottom: space.md,
            transform: 'translateX(-50%)',
            cursor: 'pointer',
            padding: `${space.xs}px ${space.lg}px`,
            borderRadius: radius.pill,
            border: `1px solid ${token('borderStrong')}`,
            background: token('surface'),
            color: token('text'),
            fontSize: fontSize.sm,
            fontWeight: 600,
            boxShadow: elevation('menu'),
          }}
        >
          {jumpLabel} ↓
        </button>
      )}
    </div>
  );
}
