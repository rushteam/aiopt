// App-shortcut registry — the single source of truth for every rebindable
// keyboard shortcut.
//
// This is a faithful port of Cindy's `shared/appShortcuts.ts`, de-business-ified
// to the framework's own actions. The MECHANISM is intact: a user can rebind any
// shortcut, the change is validated (bindable / system-reserved / cross-shortcut
// conflict), only the user's diffs are persisted, and BOTH the main process
// (menu accelerators) and the renderer (`useAppShortcut`) resolve the effective
// binding by running THIS SAME code — so the two sides can never drift.
//
// Pure constants + pure functions, ZERO Electron/DOM dependency (platform is
// always passed in), so main / preload / renderer all import it. The internal
// representation is keyed on `KeyboardEvent.code` (physical key, layout
// independent); Electron accelerator strings and before-input Inputs convert to
// and match against that representation through the functions here.
//
// User overrides store only the DIFF (see main/app-shortcuts/AppShortcutStore);
// defaults evolve with this registry, and `getEffectiveAppShortcuts` merges them.

/** A normalized combo: `code` is a W3C KeyboardEvent.code; `key` is display-only fallback, never matched. */
export interface AppShortcutCombo {
  code: string;
  key?: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * Conflict-detection scope. `app` shortcuts are global and overlap everything;
 * other scopes overlap only themselves (and `app`). This is the extension point
 * a real app widens — e.g. add `editor`, `browser`, `terminal` and shortcuts in
 * non-overlapping scopes may reuse the same combo. Used ONLY for rebind-conflict
 * detection, never for display grouping.
 */
export type AppShortcutScope = 'app' | 'editor';

export const APP_SHORTCUT_IDS = ['open-settings', 'check-for-updates', 'toggle-theme'] as const;

export type AppShortcutId = (typeof APP_SHORTCUT_IDS)[number];

export interface AppShortcutDefinition {
  id: AppShortcutId;
  scope: AppShortcutScope;
  /** i18n key: shortcuts.items.<id>.label */
  labelKey: string;
  /** i18n key: shortcuts.items.<id>.description (settings row help text) */
  descriptionKey: string;
  rebindable: boolean;
  /** true = not shown in the settings list (still active, e.g. an OS-convention key). */
  hiddenInSettings?: boolean;
  /**
   * true = the ONLY trigger path is the native menu accelerator (no renderer /
   * before-input fallback). A rebind must be expressible as an Electron
   * accelerator (`comboToElectronAccelerator` non-null on darwin), otherwise the
   * UI would show it bound while the key never fires — the store and the settings
   * page both reject such a combo.
   */
  menuBacked?: boolean;
  /** Omitted = available on all platforms. */
  platforms?: ReadonlyArray<'darwin' | 'win32' | 'linux'>;
  /**
   * Per-platform default combos, multiple allowed (e.g. reload = mod+R and F5).
   * A user override replaces the whole default list with a single combo.
   */
  getDefaultCombos(platform: string): AppShortcutCombo[];
}

type ComboModifiers = Partial<Pick<AppShortcutCombo, 'meta' | 'ctrl' | 'alt' | 'shift'>>;

function combo(code: string, modifiers: ComboModifiers = {}): AppShortcutCombo {
  return {
    code,
    meta: Boolean(modifiers.meta),
    ctrl: Boolean(modifiers.ctrl),
    alt: Boolean(modifiers.alt),
    shift: Boolean(modifiers.shift),
  };
}

/** On darwin mod = ⌘; elsewhere mod = Ctrl. */
function modCombo(code: string, platform: string, extra: ComboModifiers = {}): AppShortcutCombo {
  return platform === 'darwin'
    ? combo(code, { ...extra, meta: true })
    : combo(code, { ...extra, ctrl: true });
}

// Array order = settings display order. Two menu-backed items (open settings,
// check for updates) prove the native-accelerator path; toggle-theme proves the
// renderer `useAppShortcut` path. All three are rebindable so the settings page
// exercises the full record → validate → persist → broadcast chain end to end.
export const APP_SHORTCUT_DEFINITIONS: ReadonlyArray<AppShortcutDefinition> = [
  {
    id: 'open-settings',
    scope: 'app',
    labelKey: 'shortcuts.items.open-settings.label',
    descriptionKey: 'shortcuts.items.open-settings.description',
    rebindable: true,
    menuBacked: true,
    getDefaultCombos: (platform) => [modCombo('Comma', platform)],
  },
  {
    id: 'check-for-updates',
    scope: 'app',
    labelKey: 'shortcuts.items.check-for-updates.label',
    descriptionKey: 'shortcuts.items.check-for-updates.description',
    rebindable: true,
    menuBacked: true,
    getDefaultCombos: (platform) => [modCombo('KeyU', platform)],
  },
  {
    id: 'toggle-theme',
    scope: 'app',
    labelKey: 'shortcuts.items.toggle-theme.label',
    descriptionKey: 'shortcuts.items.toggle-theme.description',
    rebindable: true,
    getDefaultCombos: (platform) => [modCombo('KeyL', platform, { shift: true })],
  },
];

const DEFINITION_MAP: ReadonlyMap<AppShortcutId, AppShortcutDefinition> = new Map(
  APP_SHORTCUT_DEFINITIONS.map((def) => [def.id, def]),
);

export function isAppShortcutId(value: unknown): value is AppShortcutId {
  return typeof value === 'string' && DEFINITION_MAP.has(value as AppShortcutId);
}

export function getAppShortcutDefinition(id: AppShortcutId): AppShortcutDefinition {
  const def = DEFINITION_MAP.get(id);
  if (!def) throw new Error(`unknown app shortcut id: ${id}`);
  return def;
}

export function isAppShortcutAvailableOnPlatform(id: AppShortcutId, platform: string): boolean {
  const def = DEFINITION_MAP.get(id);
  if (!def) return false;
  if (!def.platforms) return true;
  return (def.platforms as readonly string[]).includes(platform);
}

/**
 * A user override value: a combo = rebound to a new combo; `null` = binding
 * deleted (the shortcut is disabled, its effective list is empty, so every
 * consumer naturally stops matching).
 */
export type AppShortcutOverrideValue = AppShortcutCombo | null;
export type AppShortcutOverrides = Partial<Record<AppShortcutId, AppShortcutOverrideValue>>;

/** Validate and normalize a single combo; structurally invalid input returns null. */
export function normalizeAppShortcutCombo(raw: unknown): AppShortcutCombo | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<AppShortcutCombo>;
  if (typeof candidate.code !== 'string' || candidate.code.trim().length === 0) return null;
  if (MODIFIER_CODES.has(candidate.code)) return null;
  return {
    code: candidate.code,
    key: typeof candidate.key === 'string' ? candidate.key : undefined,
    meta: Boolean(candidate.meta),
    ctrl: Boolean(candidate.ctrl),
    alt: Boolean(candidate.alt),
    shift: Boolean(candidate.shift),
  };
}

/**
 * The default combos of a NON-rebindable shortcut are "code-reserved" keys.
 * A stored override from an older version may collide with one (the reserved key
 * may have been introduced after the user's rebind, and collisions are only
 * checked on write, not on load). A colliding stored override must be dropped on
 * normalization (that id self-heals back to its default), otherwise two
 * independent listeners would fire concurrently for the same keypress.
 */
function collidesWithNonRebindableDefault(comboValue: AppShortcutCombo, platform: string): boolean {
  for (const def of APP_SHORTCUT_DEFINITIONS) {
    if (def.rebindable) continue;
    if (!isAppShortcutAvailableOnPlatform(def.id, platform)) continue;
    if (def.getDefaultCombos(platform).some((c) => appShortcutCombosEqual(c, comboValue))) {
      return true;
    }
  }
  return false;
}

/**
 * Normalize an override set: drop unknown ids, non-rebindable ids, ids
 * unavailable on the current platform, invalid combos, and stored combos that
 * collide with a non-rebindable default. `null` values (deleted bindings) are
 * kept as-is. After a version bump that removes an id, stored overrides
 * self-heal on load.
 */
export function normalizeAppShortcutOverrides(raw: unknown, platform: string): AppShortcutOverrides {
  if (!raw || typeof raw !== 'object') return {};
  const result: AppShortcutOverrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAppShortcutId(key)) continue;
    const def = DEFINITION_MAP.get(key);
    if (!def || !def.rebindable) continue;
    if (!isAppShortcutAvailableOnPlatform(key, platform)) continue;
    if (value === null) {
      result[key] = null;
      continue;
    }
    const normalized = normalizeAppShortcutCombo(value);
    if (!normalized) continue;
    if (collidesWithNonRebindableDefault(normalized, platform)) continue;
    result[key] = normalized;
  }
  return result;
}

/**
 * Merge defaults + overrides into each id's effective combo list. A single-combo
 * override replaces the whole default list; `null` (deleted) → empty list;
 * platform-unavailable ids are absent from the result (consumers treat undefined
 * / empty as "no binding").
 */
export function getEffectiveAppShortcuts(
  overrides: AppShortcutOverrides,
  platform: string,
): Map<AppShortcutId, AppShortcutCombo[]> {
  const result = new Map<AppShortcutId, AppShortcutCombo[]>();
  for (const def of APP_SHORTCUT_DEFINITIONS) {
    if (!isAppShortcutAvailableOnPlatform(def.id, platform)) continue;
    const override = overrides[def.id];
    if (override === null) {
      result.set(def.id, []);
    } else {
      result.set(def.id, override ? [override] : def.getDefaultCombos(platform));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface PressedKeyState {
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** The core predicate both sides funnel into, so matching physically cannot drift. */
function matchesNormalized(pressed: PressedKeyState, comboValue: AppShortcutCombo): boolean {
  return (
    pressed.code === comboValue.code &&
    pressed.meta === comboValue.meta &&
    pressed.ctrl === comboValue.ctrl &&
    pressed.alt === comboValue.alt &&
    pressed.shift === comboValue.shift
  );
}

/** Match against a renderer KeyboardEvent shape (structural, no DOM types). */
export function matchesKeyboardEvent(
  event: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  comboValue: AppShortcutCombo,
): boolean {
  return matchesNormalized(
    {
      code: event.code,
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
    },
    comboValue,
  );
}

/** Match against a main-process before-input-event Input shape. */
export function matchesElectronInput(
  input: { code: string; meta: boolean; control: boolean; alt: boolean; shift: boolean },
  comboValue: AppShortcutCombo,
): boolean {
  return matchesNormalized(
    {
      code: input.code,
      meta: input.meta,
      ctrl: input.control,
      alt: input.alt,
      shift: input.shift,
    },
    comboValue,
  );
}

export function matchesAnyCombo<E>(
  event: E,
  combos: AppShortcutCombo[] | undefined,
  matcher: (event: E, comboValue: AppShortcutCombo) => boolean,
): boolean {
  if (!combos || combos.length === 0) return false;
  return combos.some((c) => matcher(event, c));
}

// ---------------------------------------------------------------------------
// Electron accelerator conversion
// ---------------------------------------------------------------------------

/** code → Electron accelerator key part (only codes that map safely). */
const ACCELERATOR_KEY_BY_CODE: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

/**
 * combo → Electron accelerator string. Unmappable codes return null: the menu
 * item silently degrades to no accelerator (click still works) and the real
 * keypress is handled by the match path.
 */
export function comboToElectronAccelerator(
  comboValue: AppShortcutCombo,
  platform: string,
): string | null {
  const keyPart = acceleratorKeyForCode(comboValue.code);
  if (!keyPart) return null;
  const parts: string[] = [];
  if (comboValue.ctrl) parts.push('Ctrl');
  if (comboValue.alt) parts.push('Alt');
  if (comboValue.shift) parts.push('Shift');
  if (comboValue.meta) parts.push(platform === 'darwin' ? 'Command' : 'Super');
  parts.push(keyPart);
  return parts.join('+');
}

function acceleratorKeyForCode(code: string): string | null {
  const letter = code.match(/^Key([A-Z])$/)?.[1];
  if (letter) return letter;
  const digit = code.match(/^Digit([0-9])$/)?.[1];
  if (digit) return digit;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return ACCELERATOR_KEY_BY_CODE[code] ?? null;
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

/** code → human-readable key label (display only). */
const DISPLAY_KEY_LABELS: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  Numpad0: 'Num 0',
};

/**
 * Cross-platform display formatting: mac uses ⌃⌥⇧⌘ with no separator (Apple's
 * order), other platforms use Ctrl+Alt+Shift+Meta+Key.
 */
export function formatAppShortcutCombo(comboValue: AppShortcutCombo, platform: string): string {
  const keyLabel = displayKeyForCode(comboValue.code, comboValue.key);
  if (platform === 'darwin') {
    const parts: string[] = [];
    if (comboValue.ctrl) parts.push('⌃');
    if (comboValue.alt) parts.push('⌥');
    if (comboValue.shift) parts.push('⇧');
    if (comboValue.meta) parts.push('⌘');
    parts.push(keyLabel);
    return parts.join('');
  }
  const parts: string[] = [];
  if (comboValue.ctrl) parts.push('Ctrl');
  if (comboValue.alt) parts.push('Alt');
  if (comboValue.shift) parts.push('Shift');
  if (comboValue.meta) parts.push('Meta');
  parts.push(keyLabel);
  return parts.join('+');
}

function displayKeyForCode(code: string, key?: string): string {
  const explicit = DISPLAY_KEY_LABELS[code];
  if (explicit) return explicit;
  const letter = code.match(/^Key([A-Z])$/)?.[1];
  if (letter) return letter;
  const digit = code.match(/^Digit([0-9])$/)?.[1];
  if (digit) return digit;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (key && key.length === 1 && key !== ' ') return key.toUpperCase();
  return key || code;
}

// ---------------------------------------------------------------------------
// Recording & validity
// ---------------------------------------------------------------------------

const MODIFIER_CODES = new Set([
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'ShiftLeft',
  'ShiftRight',
  'Fn',
  'FnLock',
  'CapsLock',
]);

/** Settings-page recording helper: a pure-modifier event returns null (wait for the main key). */
export function createAppShortcutComboFromEvent(event: {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): AppShortcutCombo | null {
  if (!event.code || MODIFIER_CODES.has(event.code)) return null;
  return {
    code: event.code,
    key: event.key,
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
}

/** Non-printing keys allowed with Shift alone (Shift+letter/digit is normal typing). */
const SHIFT_ONLY_ALLOWED_CODES =
  /^(Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|F([1-9]|1[0-9]|2[0-4]))$/;

/**
 * Bare-key limit: with no modifier only F1-F24 is allowed; with Shift alone only
 * a non-printing key (e.g. Shift+Tab); any meta/ctrl/alt makes it bindable.
 */
export function isAppShortcutComboBindable(comboValue: AppShortcutCombo): boolean {
  if (comboValue.meta || comboValue.ctrl || comboValue.alt) return true;
  if (comboValue.shift) return SHIFT_ONLY_ALLOWED_CODES.test(comboValue.code);
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(comboValue.code);
}

export function appShortcutCombosEqual(a: AppShortcutCombo, b: AppShortcutCombo): boolean {
  return (
    a.code === b.code &&
    a.meta === b.meta &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift
  );
}

/** Scope overlap: `app` overlaps everything; other scopes overlap only themselves. */
export function appShortcutScopesOverlap(a: AppShortcutScope, b: AppShortcutScope): boolean {
  return a === 'app' || b === 'app' || a === b;
}

/**
 * Cross-id conflict detection: when binding `comboValue` to `id`, does it collide
 * with another id's effective combos (defaults + overrides merged) within an
 * overlapping scope? Returns the occupying id, or null. The renderer's settings
 * pre-check and the main store's write-time fallback share this function so the
 * two never disagree.
 */
export function findAppShortcutConflict(
  id: AppShortcutId,
  comboValue: AppShortcutCombo,
  overrides: AppShortcutOverrides,
  platform: string,
): AppShortcutId | null {
  const selfDef = DEFINITION_MAP.get(id);
  if (!selfDef) return null;
  const effective = getEffectiveAppShortcuts(overrides, platform);
  for (const def of APP_SHORTCUT_DEFINITIONS) {
    if (def.id === id) continue;
    if (!appShortcutScopesOverlap(selfDef.scope, def.scope)) continue;
    const combos = effective.get(def.id);
    if (combos?.some((c) => appShortcutCombosEqual(c, comboValue))) return def.id;
  }
  return null;
}
