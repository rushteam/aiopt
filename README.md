# AiOpt

English | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

**One provider pool, every agent CLI, any API format.**

AiOpt is a desktop app that routes your AI coding agents to the model providers you actually
want to pay for tokens. Enter a provider once — its endpoint, key and models — then point Claude
Code, Codex, Gemini CLI, OpenCode or any other supported agent at it with a click. When the agent
and the provider speak different API formats, AiOpt's local proxy translates between them, so
Codex can run on an Anthropic model and Claude Code on any OpenAI-compatible endpoint, with no
flags, wrappers or environment variables to maintain.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/screenshots/providers-dark.png">
  <img alt="AiOpt Providers screen: agent CLIs bound to providers and models, with the provider pool below" src="docs/images/screenshots/providers-light.png">
</picture>

## Why AiOpt

Every agent CLI has its own config file, its own key slot and its own idea of which API format
it speaks. Switching models means editing `~/.claude/settings.json` by hand, then
`~/.codex/config.toml`, then a YAML file somewhere else — and pasting the same key into each.
Trying a provider whose format your agent doesn't speak isn't possible at all.

AiOpt replaces that with one place to manage providers, one switch per agent, and a translation
layer that removes the format mismatch.

## Features

### Provider pool

- **Add once, reuse everywhere.** A provider is a name, an API format, a base URL, a key and a
  model list. Every agent draws from the same pool.
- **Presets** for Anthropic, OpenAI, DeepSeek and Moonshot (Kimi), or **Custom…** for any
  gateway, relay or self-hosted endpoint.
- **Load models** straight from the provider's model list instead of typing IDs.
- **Aliases** write a shorter or agent-friendly name into the agent in place of a long model ID.
- **Upstream compatibility** strips named top-level request fields before forwarding, for strict
  gateways that reject a parameter they don't recognise instead of ignoring it.

### One-click agent binding

Nine agent CLIs are recognised: **Claude Code, Codex, Cursor, DeepSeek Harness, Gemini CLI,
Grok, Hermes, OpenCode and pi**. Eight can be bound to a provider; Cursor's CLI has no base-URL
override, so it takes part in Skills sync only.

- Pick a provider and model on the agent card and apply. AiOpt writes the agent's **own native
  config file**, so the agent runs exactly as before — no launcher, no shell alias.
- **Exclusive** agents have their active provider replaced; **additive** agents (DeepSeek
  Harness, Hermes, OpenCode) keep every provider side by side and only the default moves.
- Before its first write to any file, AiOpt keeps the **pristine original** as
  `<file>.aiopt.bak`. **Restore default** puts it back exactly — or removes the file if AiOpt
  created it.
- **View config** lists which files AiOpt manages and where, without ever displaying their
  contents (several of them hold a key).

### Cross-format translation proxy

| Agent speaks → Provider speaks | Status |
| --- | --- |
| Anthropic Messages → OpenAI Chat Completions | enabled |
| OpenAI Responses → OpenAI Chat Completions | enabled |
| OpenAI Responses → Anthropic Messages (with the reasoning bridge) | enabled |
| OpenAI Chat Completions → Anthropic Messages | reserved |

- **One loopback server, one `127.0.0.1` port, one route per binding.** Each binding gets an
  opaque token in the URL path; the route — not a guess from the request body — decides the
  translation direction, so opposite directions share the port without interfering.
- **Streaming and tool calls are translated**, not just plain text — Server-Sent Events are
  re-framed event by event in both directions.
- **The reasoning bridge** carries Claude's extended-thinking blocks and their signatures
  through the stateless Responses protocol, so a multi-turn Codex session on a Claude model keeps
  its reasoning intact.
- **Fields that can't be translated faithfully are refused** with a clear error rather than
  silently dropped, so an agent never gets a quietly different answer.
- **Stable across restarts.** The port and the per-binding tokens persist, so an agent that is
  already running keeps working after AiOpt restarts. A token is replaced the moment its
  binding is re-pointed, and dies when the binding is cleared. **Refresh port** moves the proxy
  if something else takes the port.

### Proxy mode

- **Off (default):** same-format bindings connect the agent **directly** to the provider, and
  keep working even when AiOpt isn't running. The provider's key is written into the agent's
  config file, because the agent has to send it itself.
- **On:** every binding goes through the local proxy. The agent's config then holds only a
  loopback token, **the real key never leaves AiOpt's encrypted store**, and usage is counted.
  AiOpt asks before quitting while agents depend on it.
- Cross-format bindings always use the proxy. Gemini bindings are always direct.

### Usage

Requests, success rate and input / output / total tokens for traffic that passes through the
proxy, with a daily chart and breakdowns **by provider, by agent and by model**. Only numeric
usage fields are read from replies — never content.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/screenshots/usage-dark.png">
  <img alt="AiOpt Usage screen: request and token totals, a daily token chart, and breakdowns by provider" src="docs/images/screenshots/usage-light.png">
</picture>

### Skills sync

Keep agent skills in one **central library** (inside the app's data, or at `~/.aiopt/skills`)
and sync them to every agent's skills directory:

- **Pull ←** an agent's skill into the library, **Push →** the library copy to an agent, or
  **Push to all agents** at once.
- **Diff** shows file-level changes with content previews; **merge** lets you choose, file by
  file, which side the library keeps.
- Every overwrite is atomic. Symbolic links are refused and size limits are enforced, so a
  stray link or runaway directory cannot be copied across.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/screenshots/skills-dark.png">
  <img alt="AiOpt Skills screen: a sync matrix of skills across the library and each agent" src="docs/images/screenshots/skills-light.png">
</picture>

### Everyday comforts

- **Copy proxy config** puts an OpenAI-compatible snippet for a proxied route on the clipboard,
  for pointing any other tool at the same route.
- Lives in the **menu bar / system tray**; closing the window keeps the proxy running.
- **Seven interface languages** (English, 简体中文, 日本語, 한국어, Français, Deutsch, Español),
  light / dark / system themes, and rebindable keyboard shortcuts.

## Getting started

### Install

**macOS (Apple Silicon): install with Homebrew.** This is the recommended route:

```sh
brew install --cask rushteam/tap/aiopt
```

The cask puts **AiOpt.app** in `/Applications` and clears the macOS quarantine flag, so the
first launch shows no Gatekeeper prompt. `brew upgrade --cask aiopt` moves to a new release;
`brew uninstall --cask aiopt` removes the app, and adding `--zap` also deletes its data,
including the saved keys.

Every platform can also download a build instead. Builds are attached to each
[GitHub Release](https://github.com/rushteam/aiopt/releases), built on all three platforms from
the tagged commit:

| Platform | What you download | How to install |
| --- | --- | --- |
| macOS | `.dmg` | Open it, drag **AiOpt.app** onto the **Applications** folder. |
| Windows | `Setup.exe` | Run it; Squirrel installs per-user, no admin prompt. |
| Linux | `.zip` | Unzip anywhere and run the `AiOpt` binary. |

**macOS builds are Apple Silicon (arm64) only** for now. On an Intel Mac, run from source.

#### The builds are unsigned — read this first

There is no code-signing certificate yet, so **both macOS and Windows will refuse a downloaded
build on first launch.** This is a block you have to step past deliberately, once per install.
The Homebrew cask does this step for you.

- **macOS** — the first double-click says AiOpt "cannot be opened because the developer cannot
  be verified." Dismiss it, then **right-click (or Control-click) the app → Open**, and confirm
  in the second dialog. If macOS still refuses, open **System Settings → Privacy & Security**,
  scroll to the message about AiOpt, and click **Open Anyway**.
  If it says instead that AiOpt **is damaged and can't be opened**, see the [FAQ](#faq).
- **Windows** — SmartScreen shows a blue "Windows protected your PC" screen. Click **More
  info**, then **Run anyway**.
- **Linux** — nothing blocks the app.

Only do this because you trust where the file came from — the same steps are what malware asks
of you. Signing is planned (see `docs/dev-rules/development-workflow.md` §6).

### First run

AiOpt manages configuration and translation for your agent CLIs; it does not talk to a model on
its own.

1. **Add a provider** — Providers → **Add provider**. Pick a preset or **Custom…**, paste the
   API key, and load or list the models you want. The key goes into the OS-encrypted secret
   store. Reopening the form shows "a key is saved" rather than the key; it is only displayed
   again when you press **Show**.
2. **Bind an agent** — on the agent's card, choose **Configure**, pick a provider and model, and
   **Apply**. AiOpt rewrites that agent's config file (`~/.claude/settings.json`,
   `~/.codex/config.toml`, …) to point at the provider or at the local proxy.
3. **Use the agent as you always do.** Switch models later from the same card; **Restore
   default** hands the agent's config back exactly as it was.

**AiOpt edits config files that belong to other tools.** It only ever writes the specific files
declared per agent in `shared/aiProviders.ts`, and backs each one up first, but these may be
files you set up by hand. Check **View config** before you bind.

## FAQ

### macOS says "“AiOpt” is damaged and can't be opened. You should move it to the Trash."

The file is not damaged. The build is not signed with an Apple Developer ID or notarized, and
macOS flags everything downloaded through a browser as quarantined. Gatekeeper then refuses the
app, and on Apple Silicon with a recent macOS it often calls it "damaged" — with no **Open
Anyway** button, and right-click → Open does not get past it either.

Move **AiOpt.app** into `/Applications`, then clear its extended attributes, including the
quarantine flag, in Terminal:

```sh
sudo xattr -cr /Applications/AiOpt.app
```

Open the app as usual. If it still won't start — it quits straight away, or says it is damaged
again — give it an ad-hoc signature and try once more:

```sh
codesign --force --deep --sign - /Applications/AiOpt.app
```

Only do this for a copy downloaded from this repository's
[Releases](https://github.com/rushteam/aiopt/releases) page. Installing with Homebrew skips this
step. Once the builds are signed and notarized, it goes away for everyone.

## Design

### Security as the architecture

AiOpt holds API keys and rewrites files in your home directory, so its security model is the
architecture rather than a layer on top:

- **The UI is untrusted.** The interface runs in a sandboxed renderer with context isolation and
  no Node access. A minimal preload exposes only purpose-named methods, and every IPC handler in
  the main process **checks the sender, then validates the payload at runtime** before doing
  anything.
- **Keys are encrypted by the OS** through Electron `safeStorage` — Keychain on macOS, DPAPI on
  Windows, the desktop keyring on Linux where one is available. They never reach the UI, a log,
  or a file under version control.
- **The proxy binds loopback only**, authenticates every request by its route token, injects
  the real key into the outbound request alone, never forwards upstream error bodies (they can
  echo a key), and logs method, path, status and byte counts — never bodies, headers, tokens or
  keys.
- **Writes are narrow and reversible.** Only an explicit allowlist of agent config files may be
  written; every write is atomic (temp file + rename) with a one-time backup; failures leave the
  previous file intact.
- **Fail closed.** A strict main-side CSP, locked-down Electron Fuses and navigation guards;
  corrupt records are dropped on load rather than trusted; untranslatable fields are refused.

### Engineering

- **Stack:** Electron 41, React 19, TypeScript (strict), Vite 6, Electron Forge, Vitest, pnpm
  workspaces.
- **Few moving parts.** The proxy is built on Node's own `http` module with no third-party proxy
  or SDK dependency; the translators and SSE codec are pure functions, tested without a network.
- **Tested at the edges that matter** — translators, streaming, route tokens, config adapters,
  atomic writes, and path handling for macOS, Windows and Linux; release builds run on all three.
- **Localisation is gated.** UI copy goes through i18n, and product terms are checked against an
  adjudicated glossary in CI.

## Run from source

Also the route for an Intel Mac, or any platform without an attached build. Requires Node 20+
and pnpm.

```sh
pnpm install
pnpm dev                # open the app window
```

A source run keeps its data apart from an installed copy, in `AiOpt-dev` rather than `AiOpt`
(under `~/Library/Application Support`, `%APPDATA%`, or `~/.config`). It starts with no providers,
and it never reads or changes the installed app's keys. The two can run at the same time.

## Contributing

Contributions are welcome. Every commit needs a DCO sign-off — run `pnpm dco:install-hook` once
to add it automatically. See `CONTRIBUTING.md`, and `AGENTS.md` for the rule index
(*"read rule Y before you touch area X"*); `docs/dev-rules/repo-map.md` maps the codebase.

| Command | What it enforces |
| --- | --- |
| `pnpm test:unit` | All workspace unit tests (the commit gate). |
| `pnpm -r run --if-present typecheck` | Per-package type checking. |
| `pnpm check:dco` | Every commit carries a matching DCO sign-off. |
| `pnpm check:i18n-glossary` | UI copy uses adjudicated product terms; `GLOSSARY.md` is in sync. |
| `pnpm check:version` | Both manifests state one version, matching the release tag. |

## License

[MIT](LICENSE) © 2026 RushTeam
