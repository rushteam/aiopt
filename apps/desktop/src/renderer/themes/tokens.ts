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
  accentText: { light: '#ffffff', dark: '#0d1117' },
  danger: { light: '#c8362f', dark: '#f06962' },
  focusRing: { light: '#2f6bff', dark: '#5b8bff' },
} as const satisfies Record<string, TokenValue>;

export type TokenName = keyof typeof TOKENS;

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
  el.dataset.theme = resolved;
}
