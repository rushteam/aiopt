// Pure layout math for a variable-height virtual list (see VirtualChatList).
//
// Rows are measured once they render; until then they use an estimate. Offsets are prefix sums
// of those heights, and only the rows overlapping the viewport plus an overscan band are drawn.

/** `offsets[i]` is row i's top; `offsets[n]` is the total height. */
export function prefixOffsets(heights: readonly number[]): number[] {
  const out = new Array<number>(heights.length + 1);
  out[0] = 0;
  for (let i = 0; i < heights.length; i += 1) out[i + 1] = out[i]! + heights[i]!;
  return out;
}

/** The first row whose bottom is below `y` (binary search; clamps to the list). */
export function rowAt(offsets: readonly number[], y: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1]! <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Rows to draw, `[start, end)`: those overlapping `[top - overscan, top + height + overscan]`.
 * Always at least one row when the list is non-empty.
 */
export function visibleRange(
  offsets: readonly number[],
  top: number,
  height: number,
  overscan: number,
): { start: number; end: number } {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: 0 };
  const start = rowAt(offsets, Math.max(0, top - overscan));
  const last = rowAt(offsets, top + height + overscan);
  return { start, end: Math.min(n, Math.max(last + 1, start + 1)) };
}

/** Within this distance of the bottom, the list follows new content. */
export const FOLLOW_THRESHOLD_PX = 120;

/**
 * Whether the list should keep following new content after a scroll. Scrolling up by hand
 * stops following at once; it resumes once the user is back within the threshold. A position
 * at the very bottom always follows (content shrinking can clamp the scroll position upward).
 */
export function nextFollow(input: { distanceFromBottom: number; movedUp: boolean; following: boolean }): boolean {
  if (input.distanceFromBottom <= 2) return true;
  if (input.movedUp) return false;
  return input.following || input.distanceFromBottom < FOLLOW_THRESHOLD_PX;
}

/** A rough first-render height for a text row: a few px of chrome plus wrapped lines. */
export function estimateTextHeight(text: string, charsPerLine = 70, lineHeight = 21, chrome = 20): number {
  let lines = 0;
  for (const line of text.split('\n', 400)) lines += Math.max(1, Math.ceil(line.length / charsPerLine));
  return chrome + Math.min(lines, 400) * lineHeight;
}
