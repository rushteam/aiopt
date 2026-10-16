# Upstream drivers

> **Status:** authoritative development rule
> **Read before:** adding or changing an upstream driver — a provider AiOpt serves through a
> private protocol instead of forwarding an HTTP POST to an OpenAI / Anthropic / Gemini
> compatible endpoint (today: Cursor's agent API and WorkBuddy's client-shaped chat).

Most providers are a base URL + a key, and the translation proxy forwards to them itself.
A provider whose upstream speaks something else (Connect + protobuf, a vendor RPC, …) is
served by a **driver** under `apps/desktop/src/main/upstreams/<id>/`.

## 1. Built in, never loaded

Drivers are compiled into the main bundle and listed in the composition root
(`getUpstreamRegistry()` in `services.ts`). There is **no runtime plugin loading** — no
`import()` of a user path, no npm package fetched at runtime, no script from a settings file.
A driver runs in main next to every credential and behind the IPC boundary; loading third-party
code there would hand it the whole safety floor (see
[`architecture-invariants.md`](architecture-invariants.md) §2 and
[`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)).

A user who wants an unsupported upstream today runs their own OpenAI-compatible gateway and
adds it as an ordinary provider — that already works and keeps the code out of AiOpt.

## 2. The contract (`upstreams/types.ts`)

```ts
interface UpstreamDriver {
  id: string;
  handles(provider: Provider): boolean;   // from the stored record alone
  bind(provider: Provider): BoundUpstream;
}
interface BoundUpstream {
  driverId: string;
  listModels(signal?): Promise<ProviderModel[]>;              // throws UpstreamError
  chat(body: OpenAiChatBody, signal?): Promise<UpstreamChatResult>;
}
```

- **OpenAI Chat in, OpenAI-Chat-shaped events out.** The route's outbound format is `openai`;
  the proxy has already translated the inbound dialect, and maps the events
  (`text` / `reasoning` / `tool` / `stop` + usage / `error`) back through
  `upstreams/openaiChatOut.ts` and the route's existing response transforms. A driver never
  sees Anthropic or Responses bodies. A driver-served provider must list `apiFormats: ['openai']`;
  binding it over any other outbound format is refused (`UNSUPPORTED_CAPABILITY`).
- **The driver resolves its own credential, per call.** Nothing is passed in from the
  secret store; a driver reads its source (an agent's sign-in, …) at call time. No credential
  → `chat` returns `{ error: { status: 401 } }` and `listModels` throws `noCredentialError()`.
- **Inject the transport.** Unary HTTP goes through the injected `ProxyFetch` (Electron
  `net.fetch` in production). A protocol `net.fetch` cannot carry (HTTP/2 bidi streams) may
  use `node:http2` behind an injectable connector, so tests run without a network.
- **Pure parts are pure.** Encoding, decoding, request building and model mapping are
  transport-free modules with unit tests in `upstreams/__tests__/`.

## 3. What the host does for every driver

| Where | Behavior |
| --- | --- |
| `providerManager.applyBinding` | A driver-served provider is **always proxied** (it has no endpoint an agent could call), even same-format with proxy mode off. |
| `providerManager.fetchModels` / `testProvider` | Go through `listModels` (`upstreams/providerOps.ts`), never `GET /models`. |
| `translationProxy` | `upstreamFor(providerId)` is looked up live per request; a hit is answered by `serveDriver`. |
| `providerManager.toSummary` / `updateProvider` | The summary carries `upstreamDriver: <id>`; the edit form shows the base URL and formats read-only (and hides Detect), and `updateProvider` keeps the stored base URL and forces `apiFormats: ['openai']`. An agent-import provider shows its sign-in state instead of an API key field. |

## 4. Errors and logging

- The upstream's own error text (`UpstreamFailure.message`) stays main-side: it is **not
  logged and not forwarded**. Logs record `upstream: <driverId>` and the status only; the
  client gets the generic line for the status (`clientMessage`).
- Status mapping to the client: 401/403 → 401, 429 and 400 kept, anything else → 502.
- Model-list failures surface as coded IPC errors (`UNAUTHORIZED`, `UPSTREAM_ERROR`) or a coded
  `ProviderTestResult.error`.
- Never log tokens, headers, request bodies, or upstream bodies.

## 5. Adding a driver

1. `main/upstreams/<id>/` — the client (transport injected) and `driver.ts`
   (`create<Id>Driver(deps): UpstreamDriver`).
2. Register it in `getUpstreamRegistry()` (`services.ts`). Ids are unique (the registry throws).
3. If it is an agent-import source, add/adjust the template in
   `shared/agentImportTemplates.ts` (`apiFormats: ['openai']`) and the table in
   [`agent-import-providers.md`](agent-import-providers.md).
4. An HTTP vendor that speaks OpenAI Chat but needs its own headers/body rules reads the
   answer with `upstreams/openaiChatIn.ts` (`readChatSse`). One that only needs extra headers
   is not a driver: add it to `proxy/vendorHeaders.ts`.
5. Unit-test the pure modules and the driver with a fake client; the generic proxy path is
   covered by `upstreams/__tests__/driverProxy.test.ts`.

## Review checklist

1. Is the driver compiled in and registered in `services.ts` — no runtime loading?
2. Does `chat` take OpenAI Chat only, and does the provider declare `apiFormats: ['openai']`?
3. Is the credential resolved inside the driver, never logged, never in IPC or Git?
4. Is upstream error text kept out of logs and client responses?
5. Is the transport injected, and are the pure modules unit-tested?
