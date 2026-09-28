# OAuth subscription providers

> **Status:** authoritative development rule (gated capability)
> **Read before:** adding or changing OAuth login flows, subscription-backed providers,
> provider token refresh, or any IPC that touches OAuth state.

OAuth providers let a user sign in with a vendor account (ChatGPT / Claude / Copilot-style
subscriptions) instead of pasting an API key. Tokens **never** cross into the preload or
renderer; outbound calls use the same translation proxy and `resolveUpstreamKey` path as
API-key providers.

## Credential split

| Stored where | What |
| --- | --- |
| Provider record (`providers.json`) | `credentialMode: 'oauth'`, public `oauth` config (kind, client id, authorize/token URLs, scopes, **account label** after login). No secrets. |
| OS secret store (`main_oauth_provider_<id>`) | Encrypted JSON: access token, optional refresh token, expiry epoch ms. |
| Memory only (during login) | OAuth `state`, PKCE verifier — discarded after callback or timeout. |

API-key providers are unchanged (`credentialMode` absent or `api_key`).

## Login flow (main only)

1. Renderer calls `providers:oauth-start` with a **provider id** only.
2. Main loads the provider, picks a **driver** for `oauth.kind`, starts a **loopback HTTP**
   listener on `127.0.0.1` (ephemeral port), builds authorize URL (PKCE + state), opens it
   via `openExternalUrl` (https allowlist).
3. Browser redirects to `http://127.0.0.1:<port>/callback?code=…&state=…`.
4. Main validates state, exchanges code at the token URL (injected `fetch`), stores tokens,
   updates optional `oauth.accountLabel`, broadcasts `providersChanged`.
5. On failure, return a coded IPC error — never log query strings that may contain codes.

## Outbound / proxy

- `providerManager.resolveUpstreamKey` reads a **fresh access token** from the OAuth manager
  (refresh when near expiry if a refresh token exists).
- Agent disk configs still receive **loopback proxy** URL + binding token for proxied routes;
  OAuth access tokens are **not** written into agent config files.

## Renderer surface

- `ProviderSummary.hasKey` for OAuth means **session connected** (no plaintext).
- Optional `oauthAccountLabel` for display.
- **No** `providersRevealKey` for OAuth providers (handler refuses).
- UI: Connect / Disconnect only; no API key field.

## Drivers

Built-in kinds live under `main/oauth/drivers/`. Each implements authorize URL, token
exchange, and optional refresh. Adding a new subscription vendor requires a driver + preset
review (ToS / client id policy) — not only UI.

`generic_pkce` is the reference driver (user-supplied authorize/token URLs + client id).

Subscription kinds (`openai_codex`, `anthropic_claude`, `github_copilot`) use **built-in
driver metadata** — the add-provider form must not ask for authorize/token URLs for these
(only pick the subscription preset and Connect). They may ship as stubs until endpoints and
client policy are approved.

**Relation to agent import:** In-app OAuth (PKCE + loopback) stores tokens under
`main_oauth_provider_<id>`. **Agent import** (`credentialMode: agent_import`) reuses an
agent’s on-disk sign-in instead — see `agent-import-providers.md`. The two modes are
separate; enabling built-in OAuth drivers is not a substitute for import review (and vice
versa).

## Review checklist (extends credentials-and-local-storage.md)

1. Did any access/refresh token, PKCE verifier, or authorization `code` reach logs, IPC, or Git?
2. Is loopback callback bound to `127.0.0.1` only and stopped after the attempt?
3. Does the renderer gain any new secret or arbitrary URL open without validation?
4. Was CSP left unchanged for the main window?
