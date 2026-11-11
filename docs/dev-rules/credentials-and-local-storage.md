# Credentials & local storage

> **Status:** authoritative development rule
> **Read before:** touching credential/token/authorization handling, where files land on
> disk, user-persistent data, temp files, or test directories.

Secrets and user data are the assets an attacker wants. Two mistakes dominate: writing a secret
somewhere Git can track it, and scattering user data so it can neither be found nor cleaned up.

## 1. Credentials must never reach a git-tracked path

- User credentials, tokens, authorization files, and keys **must not** be written into the
  repository or any path that could be tracked by Git — not under `apps/`, not under a
  `.local` file that isn't ignored, not into a fixture.
- Secrets at rest go through the OS-backed secret store (`security/secretStore.ts`, a wrapper
  over Electron `safeStorage`) and land only under the per-user application data directory.
  Plaintext secrets never transit the preload or the renderer.
- `.env*` files are git-ignored except a committed `.env.example` with placeholder values only.
- Logs, IPC errors, and error reports must never contain a plaintext secret, token, or full
  credential. Mask before you log (see `engineering-conventions.md` §1).

## 2. Know where each kind of data lives

Pick a location by *lifecycle*, and never hard-code an absolute path — always derive from
Electron's `app.getPath(...)`:

| Data | Location | Lifecycle |
| --- | --- | --- |
| App config / user preferences | `app.getPath('userData')` | Survives restart & update; user-owned. |
| Proxy identity (`proxy.json`: loopback port + per-binding route tokens) | `app.getPath('userData')` | Survives restart so a running agent's cached loopback config keeps working; user-owned. Route tokens are secret-class loopback credentials (NOT the real provider key, which stays in the OS secret store) — never log them; rotated only on rebind/clear. |
| Binding drift snapshot (`binding-applied.json`) + binding profiles (`binding-profiles.json`) | `app.getPath('userData')` | Metadata only (URLs, model ids, token-*presence*, provider ids) — not upstream secrets. Used to detect when agent files under `$HOME` were edited outside AiOpt; see `agent-binding-drift.md`. |
| Local database | `app.getPath('userData')` | Long-lived; migrated, never silently reset. |
| Workbench (`workbench/`: private pi config dir `pi-agent/` with `models.json` + `settings.json`, `orchestrator-extension.mjs`, an empty `orchestrator/` cwd, `folders.json`, `tasks.json`, `settings.json`, `conversations.json`, `timeline.json`, conversations in `sessions/`) | `app.getPath('userData')` | Rewritten on every workbench start except the user-owned `folders.json`, `tasks.json` (the task board, including each worker's last terminal output tail, which can quote file contents, and the commit id a task's checkout was at when it started), `settings.json` (overrides only), `timeline.json` (the Workbench timeline: the last 500 task status changes and coordinator turns — task id, title, conversation uuid, statuses, what set a turn off and how it ended, times, durations; never prompts, messages or worker output; unreadable records are dropped on load), `conversations.json` (titles the user gave conversations, keyed by session uuid; an entry goes when its conversation is deleted) and `sessions/` (pi's JSONL transcripts, one per conversation; deleted only from the history list; AiOpt never writes into them). Images pasted, dropped or picked into the coordinator composer are read in the renderer and scaled to at most 2000 px. Main re-checks the count, type (png / jpeg / gif / webp), base64 and size, and that the bytes match the type's signature, then hands them to pi, which stores them base64 in that conversation's transcript. AiOpt itself never writes or logs image data, and the transcript view shows only how many images a message carried. Sidebar search reads the listed transcripts in main, up to a byte cap per file, and searches only the user's and the assistant's text, never tool calls or their output. The read text is cached in memory only, and only while the file is unchanged. The renderer names a conversation by its session uuid alone; main maps it to a regular file it listed itself in `sessions/`, never to a path from the renderer. `models.json` names the key only as `$AIOPT_WB_KEY`; the key itself is passed through the environment of the coordinator and of AiOpt's own herdr session (`herdr --session aiopt`), never written to disk, argv, or a log. The user's `~/.pi/agent` is never touched. Task worktrees live under herdr's own `~/.herdr/worktrees/`, and their branches are kept when a task is removed. A task's changes view reads its checkout with git in main (`main/workbench/taskChanges.ts`): the renderer sends only the task id, and main picks the directory from its own record (the worktree, or the folder for an in-place task). Git runs read-only — no optional locks, fsmonitor, pager, external diff or textconv — and what it returns is capped by file count, per-file diff size and total size. Nothing is written, cached or logged; a diff stays in renderer memory while the view is open. The Explorer can create, rename, copy, move and trash entries **inside folders the user granted** (`main/workbench/folderOps.ts`). The renderer names every entry by folder id plus a relative path. Main resolves both the source and the destination with `lstat` on each component, refuses symlinks, `.git` / `node_modules` / `.DS_Store`, and a folder copied or moved into itself, never overwrites (a taken name becomes `name copy.ext`, `name copy 2.ext`, …), caps a recursive copy by entries and bytes, and skips symlinks inside it. Delete is `shell.trashItem` only, never a permanent delete. Files dropped in from Finder or Explorer are the one place an absolute path crosses IPC: preload turns each dropped `File` into a path, and main copies them into the folder only after a native confirmation that lists them. |
| Secrets | OS secret store, keyed under `userData` | Long-lived; encrypted at rest. |
| OAuth provider tokens (access + refresh) | OS secret store (`main_oauth_provider_<providerId>`) | Long-lived; encrypted at rest; main-only — never preload/renderer or agent on-disk config. See `oauth-providers.md`. |
| Caches / rebuildable artifacts | `app.getPath('cache')` | Disposable; must be safe to delete. |
| Transient scratch | `app.getPath('temp')` | Per-run; clean up on exit. |
| Logs | `app.getPath('logs')` | Rotating; masked; no secrets. |
| Agent session logs (Claude Code `~/.claude/projects/**/*.jsonl`, Codex `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, pi `~/.pi/agent/sessions/*/*.jsonl`, Cursor CLI `~/.cursor/chats/*/*/store.db`) | Owned by those agents under the agent home | **Read-only** to AiOpt: scanned main-side for the Sessions tab and the agent-log usage view, never written, symlinks not followed, oversized files skipped. Parses are cached in memory only — nothing derived is persisted. A Cursor chat (SQLite, no token counts — its usage is estimated from the message text and labelled as an estimate in the UI) is copied with its `-wal` into a fresh `mkdtemp` directory under the OS temp dir, read there and removed in a `finally`, so the original is never opened and no `-shm` / `-wal` appears beside it. The renderer names a session by `(agentId, sessionId)` alone; main resolves it to a file it listed itself. Session text is the user's conversation and is never logged. A Markdown export goes only to a path the user picks in a main-side save dialog. |
| MCP server library (`mcp-servers.json`: name, transport, command + args or URL, env/header **key names**) + values (`main_mcp_<hex name>` in the OS secret store) | `app.getPath('userData')` + OS secret store | User-owned. Env/header values live only in the secret store and do not cross IPC (the renderer sees key + `set`), except the gated one-value-per-click `mcp:reveal-value` behind the edit form's eye button. They are written in plain text into an agent's MCP config when the user pushes a server there (`~/.claude.json` `mcpServers`, `~/.codex/config.toml` `[mcp_servers.*]`, `~/.gemini/settings.json` `mcpServers`), because the agent reads them there; those files keep their permission bits (new ones `0600`). Deleting a library entry removes its secret only; agent files are left alone. See `mcp-servers.md`. |
| MCP gateway token (`main_mcp_gateway_token`) + per-server gateway fingerprint (`gateway` in `mcp-servers.json`) | OS secret store / `app.getPath('userData')` | AiOpt-owned. The token is the path secret of the opt-in loopback MCP endpoint; it never crosses IPC and is never logged. It is written into an agent's MCP config only as the `aiopt` entry's URL, when the user adds it there. The fingerprint holds the spec summary and key names, no values. See `mcp-gateway.md`. |
| Skills central library | `skillsLibrary` enum, resolved in main: `userData/skills` or `~/.agents/skills`. A previously stored `~/.aiopt/skills` is still resolved. | User-owned skill files. Switching the enum points at another directory and does not move files. On first use, if the in-app library is empty and `~/.agents/skills` already exists, that choice is recorded. `~/.agents/skills` is the cross-client user directory (home-level, not a project `.agents/` that Git would track) and is shared with other agents that scan it. |

- `userData` depends on how the app runs. A packaged build uses Electron's default,
  `<appData>/AiOpt`. An unpackaged run (`pnpm dev`) uses a sibling, `<appData>/AiOpt-dev`, set by
  `isolateDevUserData()` as the first statement of `main/index.ts` (`main/userDataDir.ts` decides
  it). A dev run must never read or write the installed app's secrets, providers, or proxy
  tokens. Nothing is migrated between the two: a dev run starts empty, and the installed app's
  data is left alone. Do not add a `getPath('userData')` call that runs at import time, because
  it would run before the redirect.
- `AIOPT_DEV_PROFILE` splits dev runs further, so two checkouts or worktrees can run at the same
  time (each userData holds its own single-instance lock). A packaged build ignores it.
  - A name (1–32 letters, digits, `-`, `_`), e.g. `AIOPT_DEV_PROFILE=pms`, gives
    `<appData>/AiOpt-dev-pms`. It persists like `AiOpt-dev`.
  - `temp` gives a fresh `mkdtemp` directory (`0700`) under the OS temp dir. On macOS and Windows
    that is per-user, never the shared `/tmp`. It is removed when the run exits.
  - Any other value, including anything path-like, stops the run with
    `user_data.dev_profile_invalid`. It is never taken as a path, so a dev run's secrets and
    proxy tokens cannot be pointed at a shared or Git-tracked location.
- Rebuildable data goes in a cache/temp location, not next to source-of-truth data, so clearing
  it can never corrupt real state.
- When adding a new persisted location, decide its lifecycle first, then document it in the
  table so cleanup and backup logic know it exists.

## 3. Tests

- Tests write only under a temp directory they create and remove; they never touch the real
  `userData` and never write a real credential.
- Fixtures use obvious placeholders, never a real token shaped to "look realistic."

## Review checklist

1. Could any secret this change handles end up on a git-tracked path or in a log?
2. Is every new on-disk path derived from `app.getPath(...)` with a documented lifecycle?
3. Do secrets stay in main / the secret store, never crossing into preload or renderer?
