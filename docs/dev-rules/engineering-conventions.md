# Engineering conventions

> **Status:** authoritative development rule
> **Read before:** adding/changing logging, IPC error handling, main-side business logic and
> its tests, cross-platform (macOS/Windows) behavior, or landing i18n copy.

## 1. Logging

- Use the structured logger (`main/logger.ts`), not bare `console.*`, for anything that should
  survive into a log file. Emit structured events (a stable event name + fields), not
  interpolated prose — structured logs are greppable and safe to redact.
- **Never log a secret, token, full credential, or raw absolute path.** Mask before logging:
  `maskPath` reduces a path to a non-identifying shape, `maskEmail` keeps only enough to
  correlate. When in doubt, log an id or a masked form, not the value.
- Log levels: `error` for a failure needing attention, `warn` for a recovered/degraded path,
  `info` for lifecycle milestones, `debug` for development detail. Don't log at `info` inside a
  hot loop.

## 2. IPC error handling

- Every IPC handler returns errors through the unified protocol (`shared/ipc-errors.ts`): a
  typed `code`, a safe message, and optional structured detail. Use `throwIpcError(code, …)`.
- The message and detail crossing to the renderer must be safe to show: **no stack traces, no
  credentials, no internal absolute paths, no verbatim upstream error bodies.** Log the rich
  detail in main; return the sanitized shape to the renderer.
- Codes are generic and reusable (`INVALID_PARAMS`, `NOT_FOUND`, `INTERNAL`, `ALREADY_EXISTS`,
  `PRECONDITION_FAILED`, `PERMISSION_DENIED`, `UNSUPPORTED_CAPABILITY`). Don't invent a
  per-feature code where a generic one fits; if a genuinely new *category* is needed, add it to
  the shared union with tests, don't stuff it into a message string.

## 3. Cross-platform

- Main-side business logic that touches paths, shells, or OS integration must work on both
  macOS and Windows. Use `path` APIs, never hand-built separators; don't assume a POSIX shell.
- Gate genuinely platform-specific behavior on `process.platform` and keep the branches beside
  each other. Note in the PR which platforms you actually ran on and which you only reasoned
  about.

## 4. Tests

- New main-side logic gets a unit test; a new security boundary gets a regression test that
  fails if the boundary is removed (see the security rule §8).
- Prefer testing the Electron-free abstraction (e.g. the IPC registry, validators, config
  merge) over standing up a real Electron process.

## 5. Internationalization

- User-facing copy goes through i18n; no hard-coded display strings in components. Add every new
  key to each locale in `apps/desktop/src/renderer/i18n/locales/<locale>/common.json`.
- Light + dark are both required for any UI (see `../design-rules/DESIGN.md`); i18n and theming
  are delivery requirements, not follow-ups.

### 5.1 Product-term glossary gate

- Before adding or changing a **product term** in UI copy, check the glossary `i18n/GLOSSARY.md`.
  Use the adjudicated translation as-is; do not coin your own.
- If a term is missing or you're unsure, add it to `i18n/glossary.json` with
  `status: "proposed"` and discuss — don't silently invent a rendering.
- A `decided` term with a `forbidden` list will **fail** the gate if a forbidden rendering
  appears in copy; a `proposed` term only warns. The gate is `pnpm check:i18n-glossary`, and it
  also verifies `GLOSSARY.md` is regenerated from `glossary.json`
  (`pnpm glossary:generate`). The glossary is a reference for correct terms, not a
  find-and-replace target.

## Review checklist

1. Any secret / absolute path / stack trace reachable in a log or an IPC error message?
2. Do IPC errors use the shared protocol with a sanitized renderer-facing shape?
3. Is new copy in every locale, passing the glossary gate, with light + dark both done?
4. Does new main logic (especially a security boundary) have a regression test?
