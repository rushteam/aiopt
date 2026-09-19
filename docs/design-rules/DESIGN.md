# Design system

> **Status:** authoritative design rule
> **Read before:** adding/changing any UI, component, layout, style, motion, or UI copy.

AiOpt ships the *structure* of a design system — semantic tokens and a dual-mode delivery gate
— not a finished brand. Fill in the token values for your product; keep the architecture and the
gate.

## 1. Semantic tokens, never raw values

- Components consume **semantic tokens** (`color.bg.surface`, `color.text.primary`,
  `color.border.subtle`, `color.accent`, `space.*`, `radius.*`, `font.*`), never raw hex,
  literal px colors, or one-off constants.
- Tokens are defined in one place (`renderer/themes/tokens.ts`) and resolved through the
  `ThemeProvider`. A new color/spacing need is a new token, not an inline value.
- The token layer has two tiers: a small **primitive palette** (raw values, private) and the
  **semantic tokens** (what components use). Components touch only the semantic tier, so a
  palette change re-themes the app without touching components.

## 2. Dual-mode is a delivery gate, not a follow-up

- **Every UI change must implement both light and dark.** All colors go through semantic tokens
  that have a value in each mode. A hard-coded color or a patch that only works in one mode is
  **incomplete work**, not a smaller version of done.
- There is exactly one theme switch; components never branch on the current mode themselves
  (`if (dark) …` in a component is a smell — express the difference as a token that differs by
  mode).
- **Visual spot-check in both modes is encouraged but not a hard gate.** When you can't run both,
  say so honestly — state which mode you did not visually verify. Do **not** claim "dual-mode
  verified" just because the component reuses themed styles; reusing tokens is the mechanism, not
  the verification.

## 3. Copy

- All user-facing text goes through i18n (`engineering-conventions.md` §5) and product terms
  through the glossary gate (§5.1). No hard-coded display strings.

## 4. Motion & layout

- Prefer tokened durations/easings over magic numbers; respect reduced-motion preferences.
- Layout persistence is user-level config in place at the first frame — see
  `../dev-rules/architecture-invariants.md` §3.

## Delivery checklist

1. Does every color/space/radius come from a semantic token (no raw values)?
2. Do both light and dark have a real value for every token this change introduces?
3. If you couldn't visually check both modes, did you say which one you didn't verify?
4. Is all new copy i18n'd and glossary-clean?
