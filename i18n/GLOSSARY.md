# Glossary

> Generated from `i18n/glossary.json` by `pnpm glossary:generate`. Do not edit by hand —
> the gate `pnpm check:i18n-glossary` fails if this file is out of sync with the JSON.

Product terms with an adjudicated translation. `decided` terms are enforced (a forbidden rendering fails CI); `proposed` terms are under discussion and only warn.

Source locale: `en`. Locales: `en`, `zh-CN`.

## Decided

### IPC boundary (`ipc-boundary`)

The trust boundary between the untrusted renderer and the privileged main process. Every renderer request crosses it through a named IPC channel, where the main process authorizes the sender and validates the payload at runtime. Not a generic 'bridge' or 'channel'.

- **zh-CN**: IPC 边界
  - forbidden: `进程通信桥`, `通信管道`

### Main process (`main-process`)

The privileged Node.js process. Owns all OS capability; exposes it to the renderer only through authorized IPC handlers.

- **zh-CN**: 主进程

### Renderer (`renderer`)

The untrusted web context (the BrowserWindow document). Treated as hostile input; holds no privileged capability of its own.

- **zh-CN**: 渲染进程
  - forbidden: `前端页面`

## Proposed (under discussion)

### Trusted sender (`trusted-sender`)

An IPC event whose origin is verified to be the app's own top-level renderer, using only fields taken from event.sender / event.senderFrame — never renderer-reported values. Term still under discussion.

- **zh-CN**: 可信发送方
