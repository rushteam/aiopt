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

- Before each upstream attempt the proxy calls its `refreshKey` dep, which runs
  `oauthManager.getAccessToken` (refresh when near expiry if a refresh token exists); the
  synchronous `providerManager.resolveUpstreamKey` then reads the stored token. Refreshes are
  **single-flight per provider** (vendors rotate refresh tokens — two concurrent refreshes
  would burn one), a failed refresh **backs off 60 s** before the token endpoint is hit again,
  and a refresh that finishes after a disconnect / re-login is discarded (never resurrects
  cleared tokens). A failed refresh never blocks the request: the stored token goes upstream
  and the vendor's 401 surfaces as usual.
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
(only pick the subscription preset and Connect).

## Built-in subscription drivers (ChatGPT / Claude / Copilot)

These mirror each vendor's own CLI / editor login and **borrow its public client id** —
there is no third-party client registration for these subscriptions. That is a **ToS gray
area**: the vendor may block the client id, change the flow, or restrict the account. The
maintainer accepted that risk for a local client acting on the user's own sign-in; the
add-provider form shows `providers.form.oauthSubscriptionHint` so the user decides too. Any
change of client id, endpoint or identity header is a driver + preset review.

| Kind | Flow | Client id | Callback | Token store |
| --- | --- | --- | --- | --- |
| `openai_codex` | Browser, PKCE + state, form exchange at `auth.openai.com` | Codex CLI's | **Fixed** `localhost:1455/auth/callback` (the client id only allows it); a busy port (Codex CLI mid-login) fails loudly with `PRECONDITION_FAILED` | access = ChatGPT JWT (must carry a `chatgpt_account_id`), refresh rotates |
| `anthropic_claude` | Browser, PKCE + separate state, JSON exchange at `platform.claude.com` | Claude Code's | `localhost:53692/callback`, falls back to an ephemeral loopback port (Anthropic accepts any) | access = `sk-ant-oat…`, refresh rotates (old kept only if a reply omits it) |
| `github_copilot` | GitHub **device code** (`read:user`), then `copilot_internal/v2/token` | Copilot editor plugins' | none | access = Copilot API token (~30 min), **refresh slot = the GitHub OAuth token** (re-exchanged, never rotated); github.com only |

- The loopback listener always binds `127.0.0.1` (the redirect URI may say `localhost`).
- **Device code:** the user code is shown in a **main-owned native dialog**
  (`main/oauth/deviceCodeDialog.ts`), never sent to the renderer; confirming copies it to the
  clipboard and opens the device page. Only an `https://github.com/…` verification URI from
  the server is opened (`trustedVerificationUri`). Without the dialog dep the flow is
  `UNSUPPORTED_CAPABILITY`. Polling honors `slow_down`; the deadline is
  `min(expires_in, 15 min)`.
- Token-endpoint error bodies are never surfaced or logged (they may echo request fields).

### Subscription wire (`main/proxy/subscriptionWire.ts`)

A subscription token only works with the vendor client's request shape. The proxy applies it
main-side for these kinds **and** for imported Codex / Claude sign-ins (same token types):

- **Codex** (`openai-responses` only): URL `<base>/responses` (no `/v1`),
  `chatgpt-account-id` from the JWT, `originator: aiopt`, `OpenAI-Beta: responses=experimental`,
  body `store: false` and a default `instructions` when absent. The ChatGPT backend only
  streams — a non-streaming client request is rejected upstream.
- **Claude** (`anthropic` only): `authorization: Bearer` instead of `x-api-key`, the
  `oauth-2025-04-20` + `claude-code-20250219` betas, Claude Code's `user-agent` / `x-app`,
  and Claude Code's identity as the first system block (required by the subscription
  backend). Claude Code's tool-name casing is not applied.
- **Copilot** (`openai` only): the editor identity headers; the API host comes from the
  token's `proxy-ep` (`*.githubcopilot.com` only), else the preset base. Models that need a
  policy opt-in (`/models/<id>/policy`) must be enabled in GitHub first. (An imported Copilot
  sign-in is a GitHub token, not a Copilot API token, and keeps the plain path.)

The body is shallow-copied before adaptation so a failover candidate never inherits it.

Some vendors need a **custom login** (`OAuthDriver.runLogin`): the driver owns the loopback
port, authorize URL, and token exchange (e.g. Huawei CodeArts portal + STS PKCE/DPoP). The
manager still opens the URL via `openExternalUrl` and stores the returned bundle. When the
access field is a **session JSON** (temporary AK/SK + refresh material), pair it with an
upstream under `main/upstreams/<id>/` — do not send that JSON as a Bearer header.

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
