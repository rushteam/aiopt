// System-reserved shortcut table — decides whether a "modifier + physical key"
// combo would collide with an OS-level shortcut.
//
// Faithful port of Cindy's `shared/keyboardReserved.ts`. Pure data + pure
// functions, zero DOM/Electron dependency, so main and renderer share ONE
// reserved-key ruling. The basis is the W3C KeyboardEvent.code (physical key,
// layout independent).

/** Input shape for the ruling — any combo model flattens to this. */
export interface ReservedShortcutInput {
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * macOS reserved combos that must not be claimed: system editing conventions
 * (⌘A/C/V/X/Z, ⇧⌘Z, ⌘,) plus the accelerators of native menu roles (⌘Q quit,
 * ⌘H hide, ⌥⌘H hide-others, ⌘M minimize, ⌘W close, ⌘0/⌘=/⌘- and ⇧⌘= zoom,
 * ⌃⌘F full-screen). The latter are dispatched by the system BEFORE the renderer
 * sees the key, so binding them to an app shortcut is a no-op or worse.
 */
export function isMacReservedShortcut(input: ReservedShortcutInput): boolean {
  const onlyCommand = input.meta && !input.ctrl && !input.alt && !input.shift;
  const commandShift = input.meta && input.shift && !input.ctrl && !input.alt;
  const commandAlt = input.meta && input.alt && !input.ctrl && !input.shift;
  const commandCtrl = input.meta && input.ctrl && !input.alt && !input.shift;
  if (onlyCommand) {
    return new Set([
      'KeyA',
      'KeyC',
      'KeyV',
      'KeyX',
      'KeyZ',
      'Comma',
      'KeyQ',
      'KeyH',
      'KeyM',
      'KeyW',
      'Digit0',
      'Equal',
      'Minus',
    ]).has(input.code);
  }
  if (commandShift) {
    // ⇧⌘Z redo; ⇧⌘= is ⌘+ (the actual key behind the zoomIn menu role)
    return input.code === 'KeyZ' || input.code === 'Equal';
  }
  if (commandAlt) {
    return input.code === 'KeyH'; // hideOthers
  }
  if (commandCtrl) {
    return input.code === 'KeyF'; // togglefullscreen
  }
  return false;
}

/** Windows reserved system combos (Win-key combos, the Alt+Tab family, IME switching, etc.). */
export function isWindowsReservedShortcut(input: ReservedShortcutInput): boolean {
  const code = input.code;
  const ctrlOnly = input.ctrl && !input.alt && !input.shift && !input.meta;
  const altOnly = input.alt && !input.ctrl && !input.shift && !input.meta;
  const ctrlAlt = input.ctrl && input.alt && !input.shift && !input.meta;

  if (ctrlOnly && code === 'Space') return true;
  if (altOnly && new Set(['Tab', 'F4', 'Escape']).has(code)) return true;
  if (ctrlAlt && code === 'Delete') return true;

  if (!input.meta) return false;
  const onlyMeta = !input.ctrl && !input.alt && !input.shift;
  const metaShift = input.shift && !input.ctrl && !input.alt;
  const metaCtrl = input.ctrl && !input.shift && !input.alt;
  const metaAlt = input.alt && !input.ctrl && !input.shift;
  const metaCtrlShift = input.ctrl && input.shift && !input.alt;

  if (onlyMeta) {
    if (/^Digit[0-9]$/.test(code)) return true;
    return new Set([
      'KeyA',
      'KeyC',
      'KeyD',
      'KeyE',
      'KeyF',
      'KeyG',
      'KeyH',
      'KeyI',
      'KeyJ',
      'KeyK',
      'KeyL',
      'KeyM',
      'KeyN',
      'KeyO',
      'KeyP',
      'KeyQ',
      'KeyR',
      'KeyS',
      'KeyT',
      'KeyV',
      'KeyW',
      'KeyX',
      'KeyZ',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Comma',
      'Period',
      'Semicolon',
      'Slash',
      'Tab',
      'Space',
      'Home',
      'Escape',
      'Minus',
      'Equal',
      'PrintScreen',
      'Pause',
    ]).has(code);
  }

  if (metaShift) {
    return new Set(['KeyA', 'KeyS', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter']).has(
      code,
    );
  }

  if (metaCtrl) {
    return new Set([
      'KeyC',
      'KeyD',
      'KeyF',
      'KeyQ',
      'KeyV',
      'Enter',
      'Space',
      'ArrowLeft',
      'ArrowRight',
      'F4',
    ]).has(code);
  }

  if (metaAlt) {
    return new Set(['KeyB', 'KeyD', 'KeyH', 'KeyK', 'ArrowUp', 'ArrowDown']).has(code);
  }

  if (metaCtrlShift) {
    return code === 'KeyB';
  }

  return false;
}

/** Dispatch the ruling by platform family; non-mac/windows platforms reserve nothing. */
export function isSystemReservedShortcut(
  input: ReservedShortcutInput,
  platform: 'mac' | 'windows' | 'other',
): boolean {
  if (platform === 'mac') return isMacReservedShortcut(input);
  if (platform === 'windows') return isWindowsReservedShortcut(input);
  return false;
}
