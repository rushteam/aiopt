# Hearth

A security-first **Electron desktop app framework scaffold**. Hearth is not a product — it is
the reusable *primitives* of a mature Electron client, extracted and wired end-to-end so you
can start a real desktop app on a trustworthy foundation instead of rebuilding the security
model from scratch.

## The trust model (the whole point)

Hearth is built around one boundary:

> **Untrusted renderer / minimal preload / privileged main — and IPC is the authorization boundary.**

- The **renderer** is a web context. Treat it as hostile input. It holds no OS capability.
- The **preload** exposes a tiny, purpose-named bridge — never the raw `ipcRenderer`.
- The **main** process owns every privileged capability and hands it out only through IPC
  handlers that first **authorize the sender**, then **validate the payload at runtime**
  (TypeScript types are not runtime checks).

Everything else — CSP as a single main-side choke point, Electron Fuses, fail-closed
navigation guards, SQLite migrations that never rewrite history, layered config, secrets that
never touch a git-tracked path — exists to keep that boundary honest.

## The vertical slice

The scaffold does not pile up features. One end-to-end demo proves every primitive is actually
wired in:

> a renderer button → a purpose-named preload bridge method → a main IPC handler that
> **asserts a trusted sender**, then **validates the payload**, then writes to **SQLite (via a
> migration)**, replies through a **unified IPC error protocol**, and the renderer renders the
> result with **semantic tokens (light + dark)** — with all copy going through **i18n + the
> glossary**.

To add a real feature, copy the shape of that slice. It is also the living example for the
"implement & review" checklist.

## Getting started

```sh
pnpm install
pnpm dco:install-hook   # sign commits off automatically (DCO)
pnpm dev                # open the app window
```

## Gates

| Command | What it enforces |
| --- | --- |
| `pnpm test:unit` | All workspace unit tests (the commit gate). |
| `pnpm -r run --if-present typecheck` | Per-package type checking. |
| `pnpm check:dco` | Every commit carries a matching DCO sign-off. |
| `pnpm check:i18n-glossary` | UI copy uses adjudicated product terms; `GLOSSARY.md` is in sync. |

## Layout

See `docs/dev-rules/repo-map.md` for the repository map, and `AGENTS.md` for the rule index
that says *"read rule Y before you touch area X."* Start there.
