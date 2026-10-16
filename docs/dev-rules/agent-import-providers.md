# Agent session import (subscription providers)

> **Status:** authoritative development rule (gated capability)
> **Read before:** reading agent credential files for provider routing, token refresh
> write-back, or IPC that exposes import scan results.

**Agent import** exposes an installed agent's existing sign-in as a pool provider. AiOpt
does **not** duplicate tokens into `main_oauth_provider_*`; it reads the agent's
credential file on the allowlisted path at outbound time (and may refresh tokens **back
into that file** so the agent stays signed in).

## Credential split

| Stored where | What |
| --- | --- |
| Provider record | `credentialMode: 'agent_import'`, `agentImport: { agentId }` |
| Agent files | Access / refresh tokens (see supported sources) |
| AiOpt secret store | **Nothing** for import providers |

## Supported sources

| Agent | Source | Refresh write-back |
| --- | --- | --- |
| Codex | `.codex/auth.json` (`tokens`, not `auth_mode: apikey`) | Yes — OpenAI OAuth refresh |
| Claude Code | `.claude/.credentials.json` (`claudeAiOauth`), or macOS Keychain item `Claude Code-credentials` when the file is absent | Yes — writes `.credentials.json` when refreshing |
| Copilot | `~/.config/github-copilot/apps.json` and/or Copilot CLI `~/.copilot/config.json` + macOS Keychain `copilot-cli` | Best-effort; upstream is GitHub OAuth |
| dsh (DeepSeek Harness) | `$DSH_HOME/.credentials.yaml` (default `~/.dsh`; `AIOPT_AGENT_HOME` wins in dev/test), ref `DEEPSEEK_API_KEY` under `refs:` (v1) or at the root (pre-release flat layout). Symlinks are not followed. Only this ref is read, never the `AIOPT_*_KEY` refs the dsh binding writes. | No — it is a plain API key, never written by an import |
| Cursor (cursor-agent / editor) | Every source, the token with the latest `exp` winning: macOS Keychain `cursor-access-token` / account `cursor-user`; `accessToken` in `auth.json` (`~/.cursor/` on macOS, `%APPDATA%\Cursor\` on Windows, `$XDG_CONFIG_HOME/cursor/` elsewhere); the Cursor editor's `cursorAuth/accessToken` in `Cursor/User/globalStorage/state.vscdb` (read-only via `node:sqlite`). The editor renews its copy while cursor-agent's can sit expired for months, so reading only the Keychain gave a 401 | No file write by AiOpt — a token with < 5 min left is renewed by running `cursor-agent status` (30 s, deduplicated), then re-read |

| Command Code | `~/.commandcode/auth.json` `apiKey` (the CLI's Provider API key). Symlinks are not followed. | No — a plain API key |
| ZCode | `~/.zcode/v2/credentials.json` (values sealed `enc:v1:` AES-256-GCM with ZCode's own key, `ZCODE_CREDENTIAL_SECRET` or its platform fallback), the `…:coding-plan:…:api-key` entry (Z.ai preferred over BigModel); else `config.json` `provider[…coding-plan].options.apiKey` (ZCode 3.15+). `setting.json` `dataBaseDir` moves the data dir (ignored under `AIOPT_AGENT_HOME`). | No — a plain API key. The base URL (Z.ai or BigModel) is picked at import time from the key's family |
| WorkBuddy (desktop) | `CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` under the OS app-data dir. A sealed (`$wbEncrypted`) file reads as signed out. | No file write — a token within 60 s of expiry is renewed **in memory** via `/v2/plugin/auth/token/refresh` |
| Kiro (kiro-cli / IDE) | kiro-cli's `data.sqlite3` `auth_kv` (`kirocli:social:token` or `kirocli:odic:token` + `kirocli:odic:device-registration`; read-only via `node:sqlite`, under `~/Library/Application Support/kiro-cli/`, `%APPDATA%\kiro-cli\` or `~/.local/share/kiro-cli/`), else the Kiro IDE's `~/.aws/sso/cache/kiro-auth-token.json` (+ its `<clientIdHash>.json`). kiro-cli first. A company-IdP (`external-idp`) sign-in is not read. Symlinks are not followed. | No file write by AiOpt — a token with < 2 min left (or turned down with a 403) is renewed by running `kiro-cli debug refresh-auth-token` and re-read; failing that (the IDE's sign-in, or no kiro-cli) it is renewed **in memory** via Kiro's `/refreshToken` (Google/GitHub) or AWS OIDC `/token` (Builder ID / IAM Identity Center) |

Command Code and ZCode are **API keys, not sign-ins**, like dsh, and take the key both as a
bearer token and as `x-api-key` (`main/proxy/vendorHeaders.ts`; Command Code also sends its
CLI version headers). Not imported: Command Code's Go plan (`/alpha/generate`), ZCode's Start
Plan JWT, trial/gift models and team seats, and WorkBuddy's international site
(`workbuddy.ai`).

dsh is the one source that is an **API key, not a sign-in**. It still follows the same split:
the key stays in dsh's file and is read at request time (a key rotated in dsh takes effect
without re-import); nothing is copied into AiOpt's secret store. dsh's DeepSeek *account*
sign-in (`x-dsh-auth-token`) is a dsh-private API and is not imported.

macOS Keychain reads use `security find-generic-password` main-side only; tokens never cross IPC.

## Outbound / proxy

Same as OAuth providers: **always proxied** — upstream tokens never written into other
agents' config files. `resolveUpstreamKey` calls the agent-import reader synchronously;
near-expiry refresh runs on async test paths and token refresh helpers write back to the
agent file when applicable.

### Cursor is not an HTTP API

Cursor serves its models over `agent.v1.AgentService/Run` (Connect + protobuf over HTTP/2),
not an OpenAI-compatible endpoint, so a Cursor import provider is served by the **Cursor
upstream driver** (`main/upstreams/cursor/`, modelled on magpie's Cursor gateway and its
opencode plugin). The driver contract, routing and error rules are in
[`upstream-drivers.md`](upstream-drivers.md); Cursor specifics:

- Callers' tools are offered as MCP tools under the `aiopt` namespace; Cursor's own
  built-in tools (shell, files, …) are always refused — the client agent runs its own tools.
- Model listing is `AvailableModels` filtered by `GetUsableModels`.
- The `x-cursor-client-version` sent is the installed cursor-agent's (`cli-<version>`),
  else a recent fallback (`upstreams/cursor/agentCli.ts`).
- Not ported yet: the HTTP/1.1 RunSSE fallback and native session reuse across turns.

### WorkBuddy is served by a driver

WorkBuddy speaks OpenAI Chat over HTTP but only answers requests shaped like its own client's,
so it is the **WorkBuddy upstream driver** (`main/upstreams/workbuddy/`, from magpie's
WorkBuddy plugin): signed headers (`X-User-Id`, `X-Domain`, `User-Agent: WorkBuddy/<ver>`),
per-turn conversation ids, a system message always present, flagged phrases rewritten, tool
names and JSON Schemas made acceptable (names mapped back in the answer), and one retry with an
empty assistant reply when it refuses a turn after tool results. Its SSE answer is read by the
shared `upstreams/openaiChatIn.ts`, which later HTTP drivers reuse.

### Kiro is served by a driver

Kiro has no OpenAI- or Anthropic-compatible endpoint: the **Kiro upstream driver**
(`main/upstreams/kiro/`, from magpie's Kiro plugin) sends each request whole as a conversation to
`runtime.<region>.kiro.dev/generateAssistantResponse` (the region is the profile ARN's) and
reads the AWS event-stream answer (text, a leading `<thinking>` split out as reasoning, tool
calls, token usage or Kiro's context-% estimate). History is made to alternate user/assistant,
every tool call is answered (an unanswered one gets an "interrupted" error result), tool ids and
names Kiro won't take are hashed (names mapped back), and only the latest images are resent.
A sign-in that names no profile uses Builder ID's, else the first `List-Available-Profiles`
returns. Models are `List-Available-Models` (`auto` until listed). Not ported: Kiro API keys
(`ksk_…`), in-app sign-in, company-IdP sign-ins and usage/credit display.

## Renderer surface

- `providers:agent-import-scan` — metadata only (`AgentImportCandidate[]`).
- `providers:agent-import-add` — creates a provider from {@link AGENT_IMPORT_PROVIDER_TEMPLATES}.
- Provider cards show **signed in as** when import session is available (account label when known).
- No reveal-key; no token in IPC.

## Review checklist

1. Are reads limited to documented agent paths (never arbitrary renderer paths)?
2. Did any token appear in logs, IPC, or Git?
3. Does write-back preserve unrelated fields in the credential JSON (merge, not replace)?
4. For new Keychain sources: macOS-only, no token in IPC, document the service name.
