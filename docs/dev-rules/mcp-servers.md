# MCP servers

AiOpt keeps one library of MCP servers and writes it into each supported agent's own MCP
config. Code: `apps/desktop/src/main/mcp/`, shared types `src/shared/mcp.ts`, screen
`src/renderer/features/mcp/McpHome.tsx`.

## 1. Why this is a security-sensitive area

An MCP entry is **a command the agent will run** (stdio) or **a URL it will connect to and
send headers to** (http / sse). Writing one into an agent config is code execution on the
user's machine, deferred to the next agent start. So:

- **Every write that puts a spec into an agent file is confirmed in main.** `save` (when the
  server is enabled for any agent) and an enabling `toggle` call `confirmWrite`, a native
  `dialog.showMessageBox` built in `services.ts` from `mcpConfirm.ts`. The renderer cannot
  answer or skip it. Cancel is the default and the Escape answer. A declined write returns
  `{ saved: false }` and changes nothing — not the library, not the secret store, not any file.
- The dialog shows the server name, the target agents, the exact command + args or URL (cut
  at 2000 characters with a visible `…`), and env/header **key names only**.
- No confirmation for: `resync` (re-writes the spec the user already confirmed), turning an
  agent off, `delete` (only removes), and `import` (writes no agent file; the spec is already
  the user's own).
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

- **Strict reads.** A file that exists but does not parse (or whose `mcpServers` is not an
  object) is `unreadable`: shown in the UI, never written. Every write path checks this before
  touching any file and before the confirmation.
- **One read-modify-write per agent** through `writeAgentConfigFile` (allowlist → one-time
  `.aiopt.bak` → atomic replace). Names AiOpt does not manage are left exactly as they are.
- **Unmodelled fields are kept** on rewrite (timeouts, `trust`, Codex `startup_timeout_sec`,
  `[mcp_servers.x.tools.*]` sub-tables) and ignored when computing drift.
- Drift states per agent: `off`, `synced`, `missing` (not in the file), `different` (edited
  outside AiOpt, or the file is unreadable). `resync` rewrites enabled agents.

## 4. Coexisting with provider binding

Codex `config.toml` and Gemini `settings.json` are also written by the binding adapters.
`preserveMcp.ts` makes binding never change MCP:

- Codex `writeLive` renders a fresh `config.toml` and carries the current `[mcp_servers.*]`
  blocks over (`withCodexMcpBlocks`).
- Codex and Gemini `restoreDefault` roll the file back from `.aiopt.bak`, then put the current
  MCP section back (`restoreKeepingCodexMcp` / `restoreKeepingJsonMcp`), so restoring a binding
  neither drops a newer server nor revives a deleted one.
- Gemini `writeLive` already merges JSON, so `mcpServers` survives without special handling.

## 5. Tests

`src/main/mcp/__tests__/` covers the TOML splitter, strict reads and key preservation per
agent, file modes, adapter apply/restore keeping MCP, the store (confirm declined writes
nothing, values never in the snapshot or library file, rename, toggle, drift + resync,
unreadable and no-encryption refusals before confirmation, import writes no agent file), IPC
(untrusted sender rejected before side effects, payload validation) and the dialog content.
