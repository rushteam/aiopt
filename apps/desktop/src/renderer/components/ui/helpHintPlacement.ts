// Where a HelpHint bubble goes. Pure (viewport math only) so it is unit-testable.

export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Gap between the "?" and the bubble, and the minimum distance to the viewport edge. */
export const BUBBLE_GAP = 6;
export const VIEWPORT_MARGIN = 8;

/**
 * Below the anchor, horizontally centred on it; flipped above when it would run off the
 * bottom and there is more room above; clamped inside the viewport on both axes.
 */
export function placeHelpBubble(anchor: Rect, bubble: Size, viewport: Size): { top: number; left: number } {
  const centre = anchor.left + anchor.width / 2;
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - bubble.width - VIEWPORT_MARGIN);
  const left = Math.min(Math.max(VIEWPORT_MARGIN, centre - bubble.width / 2), maxLeft);

  const below = anchor.bottom + BUBBLE_GAP;
  const above = anchor.top - BUBBLE_GAP - bubble.height;
  const fitsBelow = below + bubble.height <= viewport.height - VIEWPORT_MARGIN;
  const roomAbove = anchor.top - BUBBLE_GAP - VIEWPORT_MARGIN;
  const roomBelow = viewport.height - VIEWPORT_MARGIN - below;
  let top = fitsBelow || roomBelow >= roomAbove ? below : above;
  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - bubble.height - VIEWPORT_MARGIN);
  top = Math.min(Math.max(VIEWPORT_MARGIN, top), maxTop);
  return { top: Math.round(top), left: Math.round(left) };
}
