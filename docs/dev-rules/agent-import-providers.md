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
| Agent files | Access / refresh tokens (Codex `~/.codex/auth.json`, Claude `~/.claude/.credentials.json`) |
| AiOpt secret store | **Nothing** for import providers |

## Supported sources (initial)

| Agent | File | Refresh write-back |
| --- | --- | --- |
| Codex | `.codex/auth.json` (`tokens`, not `auth_mode: apikey`) | Yes — OpenAI OAuth refresh |
| Claude Code | `.claude/.credentials.json` (`claudeAiOauth`) | Yes — Claude OAuth refresh |
| Copilot | (future) editor `apps.json` | Not implemented |

macOS Claude Keychain-only sign-ins are **not** imported yet (file path only).

## Outbound / proxy

Same as OAuth providers: **always proxied** — upstream tokens never written into other
agents' config files. `resolveUpstreamKey` calls the agent-import reader synchronously;
near-expiry refresh runs on async test paths and token refresh helpers write back to the
agent file only.

## Renderer surface

- `providers:agent-import-scan` — metadata only (`AgentImportCandidate[]`).
- `providers:agent-import-add` — creates a provider from {@link AGENT_IMPORT_PROVIDER_TEMPLATES}.
- No reveal-key; no token in IPC.

## Review checklist

1. Are reads limited to documented agent paths (never arbitrary renderer paths)?
2. Did any token appear in logs, IPC, or Git?
3. Does write-back preserve unrelated fields in the credential JSON (merge, not replace)?
4. Is Copilot / keychain import explicitly gated before enabling?
