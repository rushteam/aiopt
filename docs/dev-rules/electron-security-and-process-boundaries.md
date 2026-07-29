# Electron process boundaries & renderer security

> **Status:** authoritative development rule
> **Read before:** modifying the renderer, preload, BrowserWindow, WebView, IPC, CSP,
> navigation, external links, file/DB/credential access, or any Electron privileged capability.

This rule takes the [Electron security guide](https://www.electronjs.org/docs/latest/tutorial/security)
as its baseline. Security takes priority over shortening a code path for calling convenience.
It is the single most important document in this repo — the whole scaffold exists to hold the
boundary it describes.

## 1. Trust model

- The **renderer is an untrusted UI context.** Rendered content, file previews, web content,
  and user input may all carry malicious data. An XSS in the renderer must **not** thereby gain
  Node, filesystem, database, credential, or arbitrary IPC capability.
- The **preload is a minimal-privilege bridge**, not a general back door into the renderer.
- **Main is the privilege and trust boundary:** system APIs, persistence, network credentials,
  file access, process management, and permission decisions must happen in main (or a
  controlled separate process).
- **IPC payloads, URLs, paths, and any renderer-reported identity are untrusted.** Main must
  re-verify origin, type, length, range, ownership, and permission every time.

## 2. Code responsibilities

Draw the boundary by *"is the capability privileged, is the input trusted"* — not mechanically
by *"is this business logic."* Unprivileged pure computation and presentation orchestration may
live in the renderer or a package. Only behavior that needs system permission, persistence,
credentials, controlled network, or a security decision must cross an audited IPC into main.

### Renderer

May own component rendering, interaction state, form state, display-data transforms, and pure
UI validation — but must obey:

- Do not `import 'electron'` or `node:*` at runtime, and do not `require` Node/Electron
  capability. A compile-time-only `import type` (erased in the build) is fine.
- Do not read/write disk, database, system credentials, or environment variables, and do not
  spawn child processes.
- Do not hold long-term source-of-truth state; persistent state belongs to main or a domain
  package. The renderer holds only view state and rebuildable cache.
- Do not treat a hidden element, a disabled button, or a prompt as a permission boundary.
- Do not add credentialed network requests in the renderer to route around IPC.

### Main, packages & shared

- Main owns the Electron lifecycle, windows, security policy, IPC authorization, OS
  integration, persistence, and privileged side effects.
- Reusable domain logic goes in packages, receiving file/network/host capability through
  injected interfaces. A package does not depend on renderer components, nor import main.
- `shared` holds only cross-process protocol, types, constants, and pure functions — no
  persistence, network, or system side effects.

## 3. BrowserWindow & WebView

Every new `BrowserWindow` must set these security options **explicitly** — do not rely on the
Electron defaults:

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- `nodeIntegrationInSubFrames: false`
- `nodeIntegrationInWorker: false`
- `webSecurity: true`
- `allowRunningInsecureContent: false`
- `experimentalFeatures: false`
- do not set `enableBlinkFeatures`
- `plugins: false`
- `navigateOnDragDrop: false`

A window may add a preload, partition, or throttling config, but must not override any field
above with a looser value. `webviewTag` is off by default; a scaffold has no WebView by design.
If you introduce one, it must have its security options forced by main at `will-attach-webview`
(never trusting the renderer's tag attributes), and you must document why the exception is
unavoidable.

## 4. Preload & context bridge

- Expose only purpose-named, minimal methods via `contextBridge.exposeInMainWorld`.
- Never expose raw `ipcRenderer`, `ipcRenderer.on/send/invoke`, or any generic function that
  lets the renderer choose the channel.
- When forwarding events, **drop the `IpcRendererEvent` inside the preload** and pass only the
  constrained business payload to the renderer. Never hand the Electron event object to a
  callback.
- Each bridge method does exactly one action, with explicit argument and return types. When you
  add a capability, update the shared types, the preload declaration, the main handler, the
  error protocol, and the tests together.
- The preload does not read or return plaintext credentials, and does not expose Node objects,
  file handles, `WebContents`, or `Session` to the renderer.

## 5. IPC is the authorization boundary

- When adding `ipcMain.handle/on`, or extending an existing handler with a new privileged
  capability, verify that `event.senderFrame` is the app's own trusted top-level frame.
- Main does not trust a `userId`, window id, file ownership, or permission conclusion sent by
  the renderer; identity is derived from `event.sender` / `senderFrame` and the registration
  main itself holds.
- A handler validates the payload's structure, length, enum values, path range, and resource
  ownership **before** any side effect. TypeScript types are not runtime validation.
- Treat "the renderer sent an absolute path" as *not* an authorization. Route file access
  through a controlled grant, never a raw path.
- Errors use the unified IPC error protocol; never return a stack trace, credentials, internal
  absolute paths, or a sensitive response verbatim to the renderer.

## 6. Remote content, navigation & external links

- The app's own renderer does not load remote application code. Remote web content, if any,
  goes into an isolated WebView; ordinary links go to the system browser.
- All navigation and new-window requests are constrained by main's `will-navigate` and
  `setWindowOpenHandler`. The renderer must not loosen them.
- `shell.openExternal` accepts only a target that passed `URL` parsing and a protocol
  allowlist. User-clickable external links are limited to `http:` / `https:`; any custom scheme
  (e.g. opening system settings) must be a static, exact allowlist.
- Never hand an unvalidated command, `file://` URL, or arbitrary custom scheme to the system
  shell.
- When adding a session that loads remote content, set both `setPermissionRequestHandler` and
  `setPermissionCheckHandler`, denying by default; verify the real origin and permission type
  before allowing.

## 7. CSP, protocols & Electron Fuses

- The app CSP is injected in one place — `main/security/csp.ts`, via
  `session.webRequest.onHeadersReceived`. Do not register another listener that would override
  it. It is a single choke point on purpose.
- The production build must not add remote scripts, `'unsafe-inline'`, or `'unsafe-eval'`.
  Production `script-src` is `'self'` with no exceptions. Any new need is a security review,
  not a casual widening of `script-src` / `connect-src` / `frame-src`.
- Prefer a scoped custom protocol for new local-resource channels over adding `file://` read
  paths.
- The packaged build must keep the Fuses: disable `RunAsNode`, Node options, and CLI inspect;
  enable cookie encryption, embedded ASAR integrity validation, and load the app only from
  ASAR.
- Use a currently-supported Electron version; on upgrade, re-check the official security
  checklist, default changes, and breaking changes. Do not delete an explicit setting because
  "the default is already safe."

## 8. Implement & review checklist

When adding or extending a capability, answer at least:

1. Did the renderer gain new privileged data or capability? Can it be narrowed further?
2. Does the BrowserWindow/WebView keep sandbox, context isolation, no Node, and web security?
3. Does the preload expose only fixed methods and strip the Electron event?
4. Does the IPC handler verify sender, payload, resource ownership, and permission?
5. Are URLs, navigation, external links, downloads, and custom protocols fail-closed?
6. Was CSP or a Fuse loosened? If so, why is it unavoidable and how is the risk verified?
7. Did a new security boundary get an automated test that prevents regression?

Minimal verification:

```bash
pnpm --filter desktop exec vitest run src/main/security/__tests__/csp.test.ts src/main/security/__tests__/navigation.test.ts
pnpm --filter desktop typecheck
```
