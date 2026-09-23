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

## Install and use

Builds for macOS, Windows and Linux are attached to each [GitHub
Release](https://github.com/rushteam/aiopt/releases), produced on all three platforms from the
tagged commit:

| Platform | What you download | How to install |
| --- | --- | --- |
| macOS | `.zip` | Unzip, drag **AiOpt.app** into `/Applications`. |
| Windows | `Setup.exe` | Run it; Squirrel installs per-user, no admin prompt. |
| Linux | `.zip` | Unzip anywhere and run the `AiOpt` binary. |

> **No release has been published yet** — that page is empty until the first `v*` tag is
> pushed. Until then, run from source (below).

### The builds are unsigned — read this first

There is no code-signing certificate yet, so **both macOS and Windows will refuse the app on
first launch.** This is not a warning you can ignore; it is a block you have to step past
deliberately, once per install:

- **macOS** — the first double-click says AiOpt "cannot be opened because the developer cannot
  be verified." Dismiss it, then **right-click (or Control-click) the app → Open**, and confirm
  in the second dialog. Right-click → Open is the part that matters: it is a different code
  path from double-clicking, and it is what lets you through. If macOS still refuses, open
  **System Settings → Privacy & Security**, scroll to the message about AiOpt, and click **Open
  Anyway**.
- **Windows** — SmartScreen shows a blue "Windows protected your PC" screen. Click **More
  info**, then **Run anyway**.
- **Linux** — nothing blocks the app.

Only do this because you trust where the file came from. The same steps are what malware asks
of you, which is exactly why signing matters and why this section exists instead of a
reassuring sentence. Signing is planned — see `docs/dev-rules/development-workflow.md` §6.

**macOS builds are Apple Silicon (arm64) only.** The release runner is `macos-latest`, which is
arm64, so there is no Intel build yet. On an Intel Mac, run from source (below).

### First run

AiOpt is a config manager and translation proxy for agent CLIs — it does not talk to a model on
its own. The shortest useful path:

1. **Add a provider** — Providers → *Add provider*. Pick a preset or choose Custom, paste the
   API key, and list the models you want. The key goes into the OS-encrypted secret store and
   never into a git-tracked file. Reopening the form shows "a key is saved" instead of the key —
   it comes back in the clear only when you press **Show**, which is a deliberate, gated
   exception rather than how the app normally reads keys.
2. **Bind an agent** — each agent card picks a provider and model. AiOpt rewrites that agent's
   own config file (`~/.claude/settings.json`, `~/.codex/config.toml`, …) to point at the local
   proxy, so the agent needs no flags and no knowledge that a translation happened.
3. **Use the agent as you always do.** Requests go through `127.0.0.1`, get translated if the
   agent and the provider disagree on wire format, and carry the real key only on the outbound
   leg.

Nine agent CLIs are recognised: Claude Code, Codex, Cursor, DeepSeek Harness, Gemini CLI, Grok,
Hermes, OpenCode and pi. Eight of them can be bound to a provider — Cursor cannot, because its
CLI has no base-URL override, so it appears only in the Skills sync.

**AiOpt edits config files that belong to other tools.** It writes only to the known files
listed per agent in `shared/aiProviders.ts`, but they are the same files you may have set up by
hand. Look at what an agent card says it will change before you bind it.

### Run from source

Also the route for an Intel Mac, or any platform with no build attached.

```sh
pnpm install
pnpm dev                # open the app window
```

Contributors want one more step — `pnpm dco:install-hook` adds the DCO sign-off trailer to
every commit automatically (see **Gates** below).

## Gates

| Command | What it enforces |
| --- | --- |
| `pnpm test:unit` | All workspace unit tests (the commit gate). |
| `pnpm -r run --if-present typecheck` | Per-package type checking. |
| `pnpm check:dco` | Every commit carries a matching DCO sign-off. |
| `pnpm check:i18n-glossary` | UI copy uses adjudicated product terms; `GLOSSARY.md` is in sync. |
| `pnpm check:version` | Both manifests state one version, matching the release tag. |

## Layout

See `docs/dev-rules/repo-map.md` for the repository map, and `AGENTS.md` for the rule index
that says *"read rule Y before you touch area X."* Start there.
