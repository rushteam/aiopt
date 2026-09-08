// Hover-background feedback for the app's custom <button>s.
//
// Controls are styled with inline `style`, and an inline style declaration beats
// any stylesheet rule — including `:hover` — on specificity. So a global CSS hover
// rule can't reach these controls; hover is applied imperatively instead, the same
// pattern the title-bar MenuButton established.
//
// `hoverBackground(rest, hover)` returns the `onMouseEnter`/`onMouseLeave` pair to
// spread onto a button. Pass the control's RESTING background so leave restores it
// exactly, and the background it should raise to on hover (usually a token). A
// disabled button is skipped, so a non-interactive control never lights up.

import type { MouseEvent } from 'react';

export function hoverBackground(
  rest: string,
  hover: string,
): {
  onMouseEnter: (e: MouseEvent<HTMLButtonElement>) => void;
  onMouseLeave: (e: MouseEvent<HTMLButtonElement>) => void;
} {
  return {
    onMouseEnter: (e) => {
      if (e.currentTarget.disabled) return;
      e.currentTarget.style.background = hover;
    },
    onMouseLeave: (e) => {
      e.currentTarget.style.background = rest;
    },
  };
}
