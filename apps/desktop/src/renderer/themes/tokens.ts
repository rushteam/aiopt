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
  // Separator / divider lines — hairlines whose job is to group, not to be read.
  // Deliberately low-contrast (~1.3:1); WCAG 1.4.11 does not apply to decoration.
  border: { light: '#d8dbe0', dark: '#2f333b' },
  // A CONTROL's outline (button, input, switch track). WCAG 1.4.11 requires 3:1 for
  // the visual boundary of a UI component, and `border` at ~1.28:1 is nowhere near it
  // — on a custom <button> with no fill and body-colored text, that boundary is the
  // ONLY signal the thing is clickable. Chosen so even the hovered surface keeps 3:1
  // (light 3.47:1 on surfaceHover, dark 3.28:1), so the ring never drops below the bar
  // in any state. Never use this for a divider; never use `border` on a control.
  borderStrong: { light: '#787d86', dark: '#757b84' },
  // The one emphasis color: a filled primary button, an active tab, a selected nav row.
  // It has to clear 4.5:1 BOTH WAYS — as a fill under `accentText`, and as text itself on
  // bg/surface/surfaceHover — because the app uses it for both. The hue is unchanged
  // (222.7°, the original blue); only its value/saturation came down, because the original
  // #2f6bff was 4.50:1 under white and 4.16:1 as text on a card — a hair under AA at the
  // very place the eye is meant to land. Now 5.47:1 filled, 4.58:1 as text at its worst
  // ground. tokens.test.ts holds both directions.
  accent: { light: '#295fe3', dark: '#84a5f5' },
  // Hover state for a filled accent control. Darker in light mode, lighter in dark
  // — a hovered control moves AWAY from the page background in either mode.
  accentHover: { light: '#1f4dc2', dark: '#a8c0fb' },
  accentText: { light: '#ffffff', dark: '#0d1117' },
  danger: { light: '#c8362f', dark: '#f06962' },
  // Hover state for a filled danger control (same move-away logic as accentHover).
  dangerHover: { light: '#ad2b25', dark: '#f4837d' },
  // Positive / healthy state — the running-proxy status dot. Slightly brighter in
  // dark mode so the small dot reads against the darker surface.
  success: { light: '#2ea043', dark: '#3fb950' },
  // Tracks `accent` — one emphasis hue, so a focused control and an active one agree.
  focusRing: { light: '#295fe3', dark: '#84a5f5' },
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
  xl: 16, // dialog titles, sub-headings
  '2xl': 18, // section headings
  // The scale's top step. No screen currently uses it: the per-screen page title is
  // visually hidden because the tab bar already names the screen, so the largest thing
  // actually rendered is a section heading. Kept as the step above `2xl` — a type scale
  // is a scale, not a list of what happens to be on screen today.
  '3xl': 22,
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
