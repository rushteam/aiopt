# MCP gateway

> Read before changing the opt-in MCP gateway: `main/mcp/mcpGateway.ts`, the gateway parts
> of `main/mcp/mcpStore.ts`, the gateway hook in `main/proxy/translationProxy.ts`, or
> `shared/mcpGateway.ts`. The MCP library itself is covered by `mcp-servers.md`.

## 1. What it is

The gateway is off by default (`mcpGateway` preference). When it is on:

- AiOpt serves **one** MCP endpoint (Streamable HTTP) on the existing translation-proxy
  listener (`127.0.0.1` only), at `http://127.0.0.1:<port>/<gateway token>/mcp`.
- Each agent gets **one** `aiopt` entry in its MCP config that points at that URL, instead
  of a copy of every library server.
- AiOpt **itself** runs the library servers the user chose for the gateway (stdio children)
  or connects to them (remote), and exposes their tools as `<server>__<tool>`
  (`shared/mcpGateway.ts`: sanitized to `[A-Za-z0-9_-]`, capped at 52 chars with a hash
  suffix, first one wins on collision).

This is a new privileged capability: AiOpt spawns programs. The user approved it as an
opt-in feature; keep every guard below.

## 2. Guards (do not weaken)

1. **Opt-in twice.** The preference must be on, *and* each server must be confirmed for the
   gateway on its own (`setGateway(name, true)`). When the preference is off, the proxy
   never dispatches to the gateway (its token is `null`), `handle` answers 404, and every
   session and child is stopped.
2. **Native confirmation per server.** Adding a server runs main's native dialog
   (`buildMcpGatewayConfirm`): name, exact command / URL, env / header **key names**, and
   the note that AiOpt runs it. A renderer bug cannot answer it. No dialog is wired → fail
   closed (`saved: false`). Removing needs no confirmation.
3. **Fingerprint, not a flag.** The library stores the fingerprint the user confirmed
   (transport, summary, sorted key names). Any spec edit makes the server `stale`: it is not
   served until the user confirms again. Changing only a *value* keeps it served (the user
   already owns values; they are never shown in the dialog).
4. **Reserved name.** `aiopt` (case-insensitive) is refused as a library name on save and
   load, is never a matrix row, and can't be pulled.
5. **Token and URL stay in main.** The token is a random 24-byte base64url string kept in
   the OS secret store (`main_mcp_gateway_token`; memory-only if encryption is unavailable).
   It is compared in constant time, never logged, never sent over IPC. The snapshot only
   carries `enabled`, per-agent `absent | same | stale`, and upstream `status` + tool count.
6. **Loopback + Host check.** The listener binds `127.0.0.1`. The MCP transport also enables
   DNS-rebinding protection (`allowedHosts` = `127.0.0.1:<port>`, `localhost:<port>`).
7. **Values main-only.** `gatewayServers()` returns live specs with values for the gateway
   process only. Upstream `version` strings are sha256 digests, so no value sits in clear.
   Child stderr is drained and dropped; logs carry event names, counts and error classes.
8. **Bounded.** 32 sessions max (LRU evicted), 30 s start timeout, 120 s call timeout
   (reset on progress), idle upstreams stopped after 10 minutes. Children inherit a safe env
   (`getDefaultEnvironment`) plus a PATH extended with the usual install dirs and the
   server's own env, with `cwd` = the user's home.
9. **Agent entry needs no dialog.** Writing `aiopt` into an agent file runs nothing: it is
   AiOpt's own loopback URL. It is refused while the gateway is off. An entry pointing
   anywhere else (old port or token) is reported `stale` and can be updated or removed.

## 3. Lifecycle

- Children start lazily on the first `tools/list` / `tools/call`, once each (concurrent
  callers share the start). `refresh()` (after any library write or turning the preference
  on) restarts upstreams whose version changed and drops removed ones; sessions get
  `tools/list_changed`.
- `stop()` runs when the preference is turned off and on `before-quit`.

## 4. Tests

- `shared/__tests__/mcpGateway.test.ts`: naming and table merge.
- `main/mcp/__tests__/mcpGateway.test.ts`: real loopback HTTP + SDK client against
  in-memory upstreams (aggregation, routing, reuse, restart on change, off = 404, Host
  check, unknown session).
- `main/mcp/__tests__/mcpStoreGateway.test.ts`: confirmation, decline / no dialog, stale on
  spec edit, reserved name, agent entry add / remove / stale, IPC sender + payload checks.
- `main/proxy/__tests__/proxyGateway.test.ts`: only the exact token reaches the gateway.
