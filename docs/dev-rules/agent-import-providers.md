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

macOS Keychain reads use `security find-generic-password` main-side only; tokens never cross IPC.

## Outbound / proxy

Same as OAuth providers: **always proxied** — upstream tokens never written into other
agents' config files. `resolveUpstreamKey` calls the agent-import reader synchronously;
near-expiry refresh runs on async test paths and token refresh helpers write back to the
agent file when applicable.

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
