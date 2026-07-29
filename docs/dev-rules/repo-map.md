# Repository map

> **Status:** orientation aid
> **Read when:** first touching this repo, locating where code belongs, or deciding which
> module a change lands in.

Hearth is a pnpm monorepo. One app (`apps/desktop`) plus shared workspace tooling. The security
boundary in `docs/dev-rules/electron-security-and-process-boundaries.md` is the organizing
principle — the directory split *is* the trust split.

## Top level

| Path | What it holds |
| --- | --- |
| `AGENTS.md` | The rule index: "read rule Y before touching area X." Start here. `CLAUDE.md` only re-exports it. |
| `docs/dev-rules/` | Engineering & security rules. |
| `docs/design-rules/DESIGN.md` | Visual system: semantic tokens, dual light/dark delivery gate. |
| `i18n/` | `glossary.json` (source) + generated `GLOSSARY.md` for the product-term gate. |
| `scripts/` | Gate implementations: DCO, glossary, workspace test runner. |
| `.githooks/`, `.github/` | DCO commit hook; PR template and DCO app config. |
| `apps/desktop/` | The Electron application. |

## `apps/desktop/src` — the trust split

```
main/        privileged process — the trust boundary
  index.ts               app lifecycle entry
  bootstrap-electron.ts  Fuses + custom protocol registration
  window/mainWindow.ts   hardened BrowserWindow
  security/csp.ts        single-point CSP injection (dev vs prod)
  security/navigation.ts will-navigate + setWindowOpenHandler + openExternal allowlist (fail-closed)
  security/trustedSender.ts  identity from event.sender only
  ipc/registry.ts        IpcHandlerRegistry (Electron-free, unit-testable) + adapter
  ipc/validate.ts        throwIpcError + runtime validators
  logger.ts              structured, PII-masked logging
  localDb/*              SQLite client + schema + migration runner        [later stage]
  config/configStore.ts  layered default → override config                [later stage]
  secrets/secretStore.ts safeStorage wrapper                              [later stage]
  demo/*                 the vertical-slice's main side                   [later stage]

preload/preload.ts   minimal contextBridge; strips IpcRendererEvent

renderer/            untrusted UI context — no Node/Electron at runtime
  index.html / index.tsx / App.tsx
  i18n/locales/<locale>/common.json
  themes/*             semantic tokens, light + dark                      [later stage]
  features/demo/*      the vertical-slice's renderer side                 [later stage]

shared/              cross-process protocol only — no side effects
  ipc-errors.ts        generic error codes + isIpcError
  ipc-channels.ts      channel allowlist + payload types
```

Entries marked `[later stage]` are planned by the scaffold's roadmap and may not exist yet;
the current pass builds the repo skeleton/gates, the Electron shell + security baseline, and the
IPC authorization primitives.

## Where does my change go?

- Needs OS permission, persistence, credentials, controlled network, or a security decision →
  `main/` (behind an audited IPC handler).
- Pure UI, interaction, or display transform → `renderer/`.
- A cross-process type, constant, or protocol → `shared/`.
- Reusable domain logic with no host coupling → a `packages/*` workspace (inject host
  capability; never import renderer or main).

When unsure, re-read the security rule's §2 "Code responsibilities" — the question is *"is the
capability privileged, is the input trusted,"* not *"is this business logic."*
