# AiOpt

A security-first **Electron desktop app framework scaffold**. AiOpt is not a product — it is
the reusable *primitives* of a mature Electron client, extracted and wired end-to-end so you
can start a real desktop app on a trustworthy foundation instead of rebuilding the security
model from scratch.

## The trust model (the whole point)

AiOpt is built around one boundary:

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

## Base features (batteries included)

Every desktop app needs the same non-business shell, so AiOpt ships it — each piece wired to
the same trust boundary (trusted sender + runtime validation, fail-closed navigation, secrets
that never reach the renderer):

- **Application menu** — a native menu whose command vocabulary (`shared/menuCommands.ts`) is
  the single source of truth reused by main (dispatch), preload (allowlist re-validation), and
  renderer (handler). Settings, Check for Updates, and About dispatch one-way to the renderer.
- **Settings** — a sectioned settings shell: Appearance, Account, Keyboard Shortcuts, Updates,
  About.
- **Appearance / theme** — `system | light | dark` on semantic tokens with **both** light and
  dark values; the preference persists via the layered config store and applies before first
  paint (no flash), through the CSSOM (CSP-safe).
- **Account (login / logout)** — a **pluggable auth provider** with a local stub. The session
  token lives only in the OS-encrypted secret store under a main-only key; the renderer sees a
  safe `signed-in / signed-out` state and never the token.
- **Keyboard shortcuts** — one registry (`shared/shortcuts.ts`) drives both the native menu
  accelerators and the Shortcuts settings list, so they can't drift.
- **Updates** — a **pluggable update provider** with a local stub that reports "up to date".
  The real update path is intentionally absent and **gated** — see `docs/dev-rules/updater.md`.
- **About** — app / Electron / Chrome / Node versions read from main.

Swap the auth and update providers for ones that talk to your backend; the manager, IPC
surface, and UI stay unchanged.

## Provider routing — one translation proxy, many routes

Agents disagree on wire format: Claude speaks Anthropic Messages, Codex/Grok speak the OpenAI
Responses API, others speak OpenAI Chat Completions. AiOpt lets an agent speaking format **X**
bind to any provider speaking format **Y** — without the agent knowing a translation happened.

> **One loopback HTTP server, on one ephemeral `127.0.0.1` port, translates every cross-format
> binding. Not one proxy per provider, not one per direction — a single server that routes by a
> per-binding path token.**

- Each binding (one agent → one provider+model) registers **one route**, addressed by an
  opaque **token in the URL path**: the agent's config points at `http://127.0.0.1:<port>/<token>`
  and appends its own native suffix (`/v1/messages`, `/v1/chat/completions`, `/responses`).
- The server strips the token, looks up the route, and the **route spec — not any sniffing of the
  request body — decides the translation direction**. So an `A→O` binding and an `O→A` binding
  coexist on the same port, told apart only by their token.
- **N providers across any mix of directions ⇒ 1 process, 1 port, N token routes.** The route
  count tracks how many agents are currently bound — nothing else.

| Inbound (agent speaks) → Outbound (provider speaks) | Status |
| --- | --- |
| Anthropic → OpenAI Chat Completions | enabled |
| OpenAI Responses → OpenAI Chat Completions | enabled |
| OpenAI Responses → Anthropic (with the reasoning bridge) | enabled |
| OpenAI Chat Completions → Anthropic | reserved |

This rides the same trust model as everything else. The token authenticates the request and
**rotates on every re-bind** (an old token dies the instant a binding is re-pointed, cleared, or
the app restarts); the agent's config holds only that token, never the real provider key. The
**real key is resolved main-side at request time** and placed into the *outbound* headers only.
Upstream error bodies are never forwarded (they can echo the key) — the client gets a generic
coded envelope — and logs record method / de-tokenized path / status / byte count only, never a
body, header, token, or key.

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
