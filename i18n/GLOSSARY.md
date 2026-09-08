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

### API format (`api-format`)

The wire protocol a provider speaks and an agent accepts — one of anthropic, openai (Chat Completions), openai-responses (OpenAI Responses), gemini. Direct binding requires the provider's format to be in the agent's accepted set; cross-format is routed through the translation proxy. Not 'protocol' or 'interface type' in UI copy.

- **zh-CN**: 接口格式

### Merge (`merge`)

Reconcile a skill that differs between the central library and an agent by picking, per file, which side's version the library keeps. The picked agent files are written back to the CENTRAL library only (the agent copy is untouched); it is not a line-level 3-way merge. Term still under discussion.

- **zh-CN**: 合并

### Official provider (`official-provider`)

A provider AiOpt ships preconfigured (Anthropic, OpenAI, etc.), seeded into the pool on first launch. Its shipped config can be restored to factory values after edits. Recognized by a stable id, distinct from a user-added custom provider. Prefer 'Official', not 'default', 'native', or 'built-in' in UI copy.

- **zh-CN**: 官方供应商
  - forbidden: `默认供应商`, `内置供应商`, `原生供应商`

### OpenAI Responses (`openai-responses-format`)

The OpenAI Responses API dialect (/responses, input/output items, reasoning items) — distinct from the older OpenAI Chat Completions dialect (labeled just 'OpenAI'). Agents that natively speak Responses (Codex, Grok) accept this format. Keep the two OpenAI dialects labeled distinctly in UI copy; do not collapse both to 'OpenAI'.

- **zh-CN**: OpenAI Responses

### Provider (`provider`)

An AI model source entered once into the global pool: a name, an API format, a base URL, an API key, and a model list. Reused across agents rather than re-entered per agent. Not 'vendor' or 'service' in UI copy.

- **zh-CN**: 供应商
  - forbidden: `厂商`, `服务商`

### Skill (`skill`)

A reusable unit of agent capability, stored as a directory containing a SKILL.md (name + description). AiOpt keeps a central library of skills and syncs them with each agent's home skills directory. Term still under discussion.

- **zh-CN**: 技能

### Agent (`target-agent`)

A target AI coding tool that AiOpt configures (Claude Code, Codex, Gemini CLI, Grok, OpenCode, pi). Each agent binds to one provider+model from the pool. Kept as 'Agent' in UI, not 'client' or 'tool'.

- **zh-CN**: Agent
  - forbidden: `客户端`

### Trusted sender (`trusted-sender`)

An IPC event whose origin is verified to be the app's own top-level renderer, using only fields taken from event.sender / event.senderFrame — never renderer-reported values. Term still under discussion.

- **zh-CN**: 可信发送方
