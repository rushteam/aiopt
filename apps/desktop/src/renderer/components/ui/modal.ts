// Shared modal plumbing.
//
// macOS: the title bar is a window-drag strip (`-webkit-app-region: drag`, TitleBar.tsx).
// Electron hit-tests drag regions on their own, regardless of what is painted on top, so
// a control of a modal that overlaps the strip (a close button near the top edge) gets
// its clicks taken as a window drag. Every modal overlay therefore declares itself a
// `no-drag` region: while a modal is open the whole window is click-through to it.

import { useEffect, useRef, type CSSProperties, type RefObject } from 'react';

export const noDragRegion = { WebkitAppRegion: 'no-drag' } as CSSProperties;

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard focus for a modal: move it inside on open (the panel itself, so no control
 * looks pre-selected), keep Tab / Shift+Tab inside, and hand it back to the opener on
 * close.
 */
export function useModalFocus<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
    panel.focus({ preventScroll: true });
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el !== panel);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return ref;
}
