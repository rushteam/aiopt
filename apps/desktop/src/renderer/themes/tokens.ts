// Semantic design tokens — the single source of truth for color.
//
// Dual-mode is a DELIVERY GATE, not an afterthought: every semantic token MUST
// define BOTH a light and a dark value. UI code references the CSS custom
// property (`var(--color-bg)`), never a raw hex, so switching the document's
// `data-theme` re-themes the whole app with no per-component branching. See
// docs/design-rules/DESIGN.md.

/** A concrete, resolved theme (never `system` — that resolves to one of these). */
export type ResolvedTheme = 'light' | 'dark';

export interface TokenValue {
  light: string;
  dark: string;
}

/** The semantic palette. Names describe ROLE, not hue, so values can change per mode. */
export const TOKENS = {
  bg: { light: '#ffffff', dark: '#16181d' },
  surface: { light: '#f5f6f8', dark: '#1e2127' },
  surfaceHover: { light: '#e9ebef', dark: '#282c34' },
  text: { light: '#1a1c20', dark: '#e8eaed' },
  textMuted: { light: '#5c6370', dark: '#9aa0aa' },
  border: { light: '#d8dbe0', dark: '#2f333b' },
  accent: { light: '#2f6bff', dark: '#5b8bff' },
  // Hover state for a filled accent control. Darker in light mode, lighter in dark
  // — a hovered control moves AWAY from the page background in either mode.
  accentHover: { light: '#2559db', dark: '#7aa2ff' },
  accentText: { light: '#ffffff', dark: '#0d1117' },
  danger: { light: '#c8362f', dark: '#f06962' },
  // Hover state for a filled danger control (same move-away logic as accentHover).
  dangerHover: { light: '#ad2b25', dark: '#f4837d' },
  // Positive / healthy state — the running-proxy status dot. Slightly brighter in
  // dark mode so the small dot reads against the darker surface.
  success: { light: '#2ea043', dark: '#3fb950' },
  focusRing: { light: '#2f6bff', dark: '#5b8bff' },
  // Modal scrim. A dark panel on a dark page needs a heavier scrim to separate
  // from the surface behind it, so dark is deeper than light.
  overlay: { light: 'rgba(0,0,0,0.45)', dark: 'rgba(0,0,0,0.6)' },
} as const satisfies Record<string, TokenValue>;

export type TokenName = keyof typeof TOKENS;

// ─── Mode-invariant scales ──────────────────────────────────────────────────
// Unlike color, these don't change between light and dark, so they are plain
// numbers used directly in inline styles (`fontSize: fontSize.md`) — no CSS-var
// indirection is needed. They promote the values the UI already used to a single
// source of truth, so a size/spacing decision lives in one place.

/** Type scale (px), smallest → largest. `base` is the default body size. */
export const fontSize = {
  xs: 11, // badges, greyed hints
  sm: 12, // secondary hints
  base: 13, // default body / help text
  md: 14, // inputs, buttons, list rows
  lg: 15, // card titles (provider / agent names)
  xl: 16, // section headings
  '2xl': 18, // modal titles
  '3xl': 22, // page title
} as const;

/** Corner radii (px). `pill` fully rounds a control (badges, "use default"). */
export const radius = {
  sm: 6, // inputs, small/icon buttons, menu items
  md: 8, // buttons, list rows
  lg: 10, // cards
  xl: 12, // modal panels
  pill: 999,
} as const;

/**
 * Layout spacing steps (px) — gaps, margins, container padding. A control's own
 * internal padding (e.g. a button's `'8px 16px'`) is a component metric and stays
 * a local literal; these tokens are for the rhythm BETWEEN elements.
 */
export const space = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 24,
} as const;

// ─── Elevation (drop shadows) ─────────────────────────────────────────────────
// The app's depth language. UNLIKE the scales above, a shadow is mode-aware — one
// tuned for a light page vanishes on a dark one, so dark is heavier — so it rides
// the same CSSOM custom-property mechanism as color (see applyThemeVariables), not
// a plain constant. `menu` lifts popovers/dropdowns; `modal` lifts dialog panels
// above the scrim (a larger, softer cast for the greater height).

export const ELEVATION = {
  menu: {
    light: '0 8px 24px rgba(0, 0, 0, 0.18)',
    dark: '0 8px 24px rgba(0, 0, 0, 0.5)',
  },
  modal: {
    light: '0 16px 48px rgba(0, 0, 0, 0.24)',
    dark: '0 16px 48px rgba(0, 0, 0, 0.6)',
  },
} as const satisfies Record<string, TokenValue>;

export type ElevationName = keyof typeof ELEVATION;

/** CSS custom-property name for an elevation (`menu` → `--elevation-menu`). */
export function elevationVarName(name: ElevationName): string {
  return `--elevation-${name}`;
}

/** Shorthand for referencing an elevation in inline styles: `boxShadow: elevation('modal')`. */
export function elevation(name: ElevationName): string {
  return `var(${elevationVarName(name)})`;
}

/** CSS custom-property name for a token (`bg` → `--color-bg`). */
export function cssVarName(token: TokenName): string {
  return `--color-${token.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
}

/** Shorthand for referencing a token in inline styles: `color: token('text')`. */
export function token(name: TokenName): string {
  return `var(${cssVarName(name)})`;
}

/** A DOM element's inline-style surface — the CSSOM entry point we write vars to. */
export interface StyleTarget {
  style: { setProperty(property: string, value: string): void };
  dataset: Record<string, string>;
}

/**
 * Apply a resolved theme's token values to a target element (default: <html>) by
 * setting CSS custom properties through the CSSOM — NOT by injecting a <style>.
 *
 * This matters for CSP: production `style-src 'self'` forbids a runtime-injected
 * inline stylesheet, but programmatic `style.setProperty` (like React's inline
 * `style` props) is exempt. So the whole theme rides on CSSOM writes and no CSP
 * relaxation is ever needed. See security rule §7.
 */
export function applyThemeVariables(resolved: ResolvedTheme, target?: StyleTarget): void {
  const el = target ?? (typeof document !== 'undefined' ? document.documentElement : undefined);
  if (!el) return;
  for (const name of Object.keys(TOKENS) as TokenName[]) {
    el.style.setProperty(cssVarName(name), TOKENS[name][resolved]);
  }
  // Elevations ride the same CSSOM path so they re-theme with the document.
  for (const name of Object.keys(ELEVATION) as ElevationName[]) {
    el.style.setProperty(elevationVarName(name), ELEVATION[name][resolved]);
  }
  el.dataset.theme = resolved;
}
