import { describe, expect, it } from 'vitest';
import { BUBBLE_GAP, VIEWPORT_MARGIN, placeHelpBubble, type Rect } from '../helpHintPlacement';

const viewport = { width: 1000, height: 800 };
const bubble = { width: 300, height: 80 };
const anchorAt = (left: number, top: number): Rect => ({ left, top, right: left + 20, bottom: top + 20, width: 20 });

describe('placeHelpBubble', () => {
  it('sits below the "?" and is centred on it', () => {
    expect(placeHelpBubble(anchorAt(490, 100), bubble, viewport)).toEqual({ top: 120 + BUBBLE_GAP, left: 500 - 150 });
  });

  it('clamps inside the left and right edges', () => {
    expect(placeHelpBubble(anchorAt(0, 100), bubble, viewport).left).toBe(VIEWPORT_MARGIN);
    expect(placeHelpBubble(anchorAt(975, 100), bubble, viewport).left).toBe(1000 - 300 - VIEWPORT_MARGIN);
  });

  it('flips above when there is no room below', () => {
    expect(placeHelpBubble(anchorAt(490, 760), bubble, viewport).top).toBe(760 - BUBBLE_GAP - 80);
  });

  it('stays on screen when it fits nowhere', () => {
    const tall = { width: 300, height: 900 };
    expect(placeHelpBubble(anchorAt(490, 400), tall, viewport).top).toBe(VIEWPORT_MARGIN);
  });
});
