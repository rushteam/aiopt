// useAppShortcut — bind a renderer action to a rebindable shortcut.
//
// Faithful port of Cindy's hook. A single window-capture keydown listener matches
// the LIVE effective combos (read from the store at press time, so a rebind takes
// effect without re-subscribing) via the same shared matcher the menu path uses.
// The handler is kept in a ref so re-renders don't churn the listener.
//
// Two guards mirror Cindy exactly:
//   • auto-repeat and IME composition are ignored (a held key / candidate window
//     must not spam the action),
//   • while the settings page is capturing a new binding
//     (`body.dataset.appShortcutRecording === '1'`) the hook yields, so recording
//     a combo never also triggers the shortcut it is being bound to.
// A handler returning `false` means "not consumed" — the event is left to bubble.

import { useEffect, useRef } from 'react';
import {
  matchesAnyCombo,
  matchesKeyboardEvent,
  type AppShortcutId,
} from '../../shared/appShortcuts';
import { getEffectiveCombosFor } from '../lib/appShortcutStore';

export interface UseAppShortcutOptions {
  /** Set false to temporarily disable the binding (e.g. a modal owns the keys). */
  enabled?: boolean;
}

export function useAppShortcut(
  id: AppShortcutId,
  handler: () => void | boolean,
  options: UseAppShortcutOptions = {},
): void {
  const enabled = options.enabled ?? true;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing) return;
      if (document.body.dataset.appShortcutRecording === '1') return;
      if (!matchesAnyCombo(event, getEffectiveCombosFor(id), matchesKeyboardEvent)) return;
      const result = handlerRef.current();
      if (result !== false) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [id, enabled]);
}
