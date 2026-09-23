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

### 1.1 A control's outline is not a divider

- `border` draws **dividers** — hairlines that group. They are decoration, so WCAG
  1.4.11 does not apply and they are deliberately low-contrast (~1.3:1).
- `borderStrong` draws a **control's boundary** — button, input, `<select>`, switch track.
  WCAG 1.4.11 requires **3:1** against the adjacent background. This app's buttons are
  custom `<button>`s with no fill and body-colored text, so that outline is the *only*
  signal the thing is clickable; `border` on a control makes it invisible.
- The same 3:1 applies to a **state indicator** — the switch thumb against its off track.
- Both are enforced by `renderer/themes/__tests__/tokens.test.ts`, which computes the
  ratios against every background a control can sit on (`bg` / `surface` / `surfaceHover`).
  A new token whose contrast job matters belongs in that test, not only in a comment.

### 1.2 `accent` is used both ways, so it must pass both ways

- The app spends `accent` as a **fill** (primary button, segmented control, selected nav row —
  with `accentText` on top) *and* as **text** (active tab, selected settings row). So it has to
  clear **4.5:1 in both directions**: under `accentText`, and against `bg` / `surface` /
  `surfaceHover`.
- Checking only one direction is the easy miss. The original `#2f6bff` was picked against white
  — 4.50:1, passing by a rounding error — and was 4.16:1 as text on a card, failing. A near-miss
  costs more here than anywhere else: `accent` marks the one thing on screen the user is meant
  to look at.
- `focusRing` tracks `accent`. One emphasis hue, so a focused control and an active one don't
  read as two different blues.
- `tokens.test.ts` asserts both directions for `accent` and `accentHover`, and that `focusRing`
  equals `accent`. Changing the blue means satisfying that test, not re-eyeballing it.

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
   And does every control outline use `borderStrong`, not `border` (§1.1)?
   If the change touches `accent`, does it still pass as a fill *and* as text (§1.2)?
2. Do both light and dark have a real value for every token this change introduces?
3. If you couldn't visually check both modes, did you say which one you didn't verify?
4. Is all new copy i18n'd and glossary-clean?
