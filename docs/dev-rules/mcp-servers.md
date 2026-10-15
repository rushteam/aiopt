# MCP servers

AiOpt keeps one library of MCP servers and syncs it with each supported agent's own MCP
config, the same way the Skills screen syncs skills. Code: `apps/desktop/src/main/mcp/`, shared types `src/shared/mcp.ts`, screen
`src/renderer/features/mcp/McpHome.tsx`.

## 1. Why this is a security-sensitive area

An MCP entry is **a command the agent will run** (stdio) or **a URL it will connect to and
send headers to** (http / sse). Writing one into an agent config is code execution on the
user's machine, deferred to the next agent start. So:

- **Only `push` writes a spec into an agent file, and every push is confirmed in main.**
  `push(name, agentIds)` calls `confirmWrite`, a native `dialog.showMessageBox` built in
  `services.ts` from `mcpConfirm.ts`. Push-to-all is one call and one dialog. The renderer
  cannot answer or skip it. Cancel is the default and the Escape answer. A declined push
  returns `{ saved: false }` and changes no file.
- The dialog shows the server name, the target agents, the exact command + args or URL (cut
  at 2000 characters with a visible `…`), and env/header **key names only**.
- No native confirmation for operations that never put a spec into an agent file:
  - `save`: library and secret store only. Agents that had the old spec show `differs`.
  - `pull`: copies an agent's entry, values included, into the library.
  - `merge`: takes picked agent fields into the library.
  - `delete`: library and secrets only. **It never touches agent files.**
  - `deleteAgent`: removes one entry from one agent file.
  The screen asks for a second, in-screen confirmation before overwrites, merges and deletes.
- All handlers call `assertTrustedSender()` first and validate the payload in main
  (`validateSaveRequest`, name pattern, enum agent ids). Renderer input never becomes a path:
  files are the fixed `MCP_CONFIG_FILES` in `agentPaths.ts`, also on the agent-config allowlist.

## 2. Values

- Env / header values are stored in the OS secret store under `main_mcp_<hex name>` as one
  JSON `{ env, headers }`. The library file holds key names only.
- Values never cross IPC. The snapshot reports `{ key, set }`; a save sends a new value or
  omits it ("keep the stored one" — only under the same server and key).
- Values cannot contain CR/LF/NUL and are size-limited (`MCP_LIMITS`).
- If secret encryption is unavailable, a save carrying values is refused **before** the
  confirmation; servers without values still work.
- Agent files receive the values in plain text — the agent reads them there. Existing file
  permission bits are kept; a file AiOpt creates is `0600`.
- URLs with embedded credentials (`https://user:pass@…`) are refused; use a header.

## 3. Agent files

| Agent | File | Section | Notes |
| --- | --- | --- | --- |
| Claude Code | `~/.claude.json` | `mcpServers` (user scope) | Claude's large state file: only `mcpServers` is touched. `type`: stdio / http / sse. Claude rewrites the file often — the UI asks users to quit it first. |
| Codex | `~/.codex/config.toml` | `[mcp_servers.<name>]` (+ `.env`, `.http_headers`) | No SSE. Line-level block splitter (`codexToml.ts`), no TOML dependency. |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` | `httpUrl` = streamable HTTP, `url` = SSE. |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` | Bare `url` for any remote server (Cursor picks HTTP or SSE), so remote entries read back as `http`. The only Cursor file AiOpt writes. |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp` | `{type: local, command: [cmd, ...args], environment}` / `{type: remote, url, headers}`. Also the OpenCode / OpenChamber binding file. Unmodelled fields (`enabled`, `timeout`, `oauth`) are kept. |
| pi | `~/.pi/agent/mcp.json` | `mcpServers` | No SSE; names only `[A-Za-z0-9_-]` (no `.`). Its own file, not one of the binding's three. |
| Hermes | `~/.hermes/config.yaml` | `mcp_servers` | No SSE. Edited as a YAML document (`yaml`, already a dependency) so comments and the binding's keys survive. Also the Hermes binding file. |

- **Strict reads.** A file that exists but does not parse (or whose servers section is not an
  object / YAML map) is `unreadable`: shown in the UI, never written. Every write path checks this before
  touching any file and before the confirmation.
- **One read-modify-write per agent** through `writeAgentConfigFile` (allowlist → one-time
  `.aiopt.bak` → atomic replace). Names AiOpt does not manage are left exactly as they are.
- **Unmodelled fields are kept** on rewrite (timeouts, `trust`, Codex `startup_timeout_sec`,
  `[mcp_servers.x.tools.*]` sub-tables) and ignored when computing drift.
- **Matrix.** Rows are the union of names in the library and in every readable agent file.
  Per agent the cell is `same`, `library-only` (push), `agent-only` (pull), or `differs`
  (diff, then push, pull or merge). It is absent when neither side has the server.
  `supported: false` marks an agent that cannot take the library's transport or name
  (`agentAcceptsServer`). The screen shows a column only for agents that are installed, are
  unreadable, or already have a server; push-to-all targets those columns only. An unreadable
  file has no cells, and its agent is flagged `unreadable`.
- **Diff and merge.** The diff lists the fields `spec`, `env:<KEY>` and `header:<KEY>` with a
  status relative to the library. It carries spec summaries only; values are compared in main
  and never sent. `merge` takes the picked agent fields into the library. When `spec` is
  picked, the transport follows the agent. Env is kept only for stdio and headers only for
  remote.

## 4. Coexisting with provider binding

Codex `config.toml`, Gemini `settings.json`, OpenCode `opencode.json` (OpenCode and
OpenChamber) and Hermes `config.yaml` are also written by the binding adapters. `preserveMcp.ts`
makes binding never change MCP:

- Codex `writeLive` renders a fresh `config.toml` and carries the current `[mcp_servers.*]`
  blocks over (`withCodexMcpBlocks`).
- Codex and Gemini `restoreDefault` roll the file back from `.aiopt.bak`, then put the current
  MCP section back (`restoreKeepingCodexMcp` / `restoreKeepingJsonMcp`), so restoring a binding
  neither drops a newer server nor revives a deleted one.
- OpenCode / OpenChamber and Hermes `restoreDefault` do the same through
  `restoreKeepingJsonMcp(file, restore, 'mcp')` and `restoreKeepingYamlMcp`.
- Gemini, OpenCode, OpenChamber and Hermes `writeLive` already merge into the parsed file, so
  their MCP section survives without special handling.

## 5. Config profiles

A binding profile (`binding-profiles.json`) also records, per MCP agent, the **names** of the
library servers present in that agent's file (`mcp`, names only — no spec, no values). Agent
entries that are not in the library are not recorded, and applying a profile never touches them. Profiles saved before
this existed have no `mcp` part, and applying them leaves MCP alone.

Applying a profile (`providerManager.applyBindingProfile`, through the injected
`ProfileMcpHook`) runs in this order:

1. `planEnabledSets` diffs the wanted sets against the library. Names no longer in the
   library, or on an agent that cannot take that transport, are skipped and counted.
   Unreadable target files refuse the whole apply here.
2. If anything gets enabled, **one** native confirmation lists every server, its agents and
   its spec. If the user declines, nothing changes: no bindings and no MCP.
3. Bindings are applied.
4. `commit` re-diffs and writes only the enables that were confirmed. A server whose spec
   changed while the dialog was open is not written. Disables only remove, so they need no
   confirmation.

## 6. Tests

`src/main/mcp/__tests__/` covers the TOML splitter, strict reads and key preservation per
agent, file modes, adapter apply/restore keeping MCP, the store (confirm declined writes
nothing, values never in the snapshot, diff or library file, save touches no agent, rename,
pull, library delete leaves agent files intact, deleteAgent, diff + merge picks, unsupported
transport and unreadable / no-encryption refusals before confirmation, profile enabled-set
plans), IPC
(untrusted sender rejected before side effects, payload validation) and the dialog content.
