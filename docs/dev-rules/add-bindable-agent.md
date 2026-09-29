# Add a bindable agent

> **Status:** authoritative development rule
> **Read when:** wiring a new agent that can be bound to a pool provider.

Most of the product derives from `AGENT_SPECS` in `shared/aiProviders.ts`. Adding a bindable
agent should touch **three places** — not drift checks, IPC lists, or allowlists by hand.

## Checklist

### 1. Catalogue — `AGENT_SPECS.<id>`

In `apps/desktop/src/shared/aiProviders.ts`, add one entry (keep alphabetical by id):

- `name`, `skillsDir` (or `null`)
- `binding`: `acceptedFormats`, `mode` (`exclusive` | `additive`), `installDir`, `files` (role → path under `$HOME`)

This automatically updates: `AGENT_IDS`, `AGENTS`, `AGENT_FILES` / write allowlist, Skills dirs,
Providers agent list, install detection.

Skills-only or import-only agents use `binding: null` — **no adapter** (see `agent-import-providers.md`).

### 2. Adapter — `main/providers/adapters/<id>Adapter.ts`

Implement `AgentAdapter` (`adapters/agentAdapter.ts`):

| Method | Purpose |
| --- | --- |
| `writeLive` | Merge/overwrite the agent's native config (via `writeAgentConfigFile`) |
| `readLiveBinding` | Same paths/fields as `writeLive`, for drift (helpers in `bindingLive.ts`) |
| `configPaths` / `detectInstalled` / `restoreDefault` | Same as existing adapters |

Copy the closest sibling: **exclusive** (Claude, Codex, Gemini, Grok) vs **additive**
(OpenCode, Hermes, dsh, pi).

### 3. Register — one line in `BINDABLE_ADAPTER_FACTORIES`

`apps/desktop/src/main/providers/adapters/registry.ts`:

```typescript
export const BINDABLE_ADAPTER_FACTORIES = {
  // …existing…
  myagent: createMyAgentAdapter,
} satisfies { [K in BindableAgentId]: () => AgentAdapter };
```

If step 1 added `binding` but you forget step 3, **TypeScript fails** (`satisfies` must list every
`BindableAgentId`). Runtime also asserts `adapter.def.id ===` the registry key.

## Tests (minimal)

- Adapter test: `writeLive` shape (mirror `grokAdapter.test.ts` or `hermesAdapter.test.ts`).
- Optional: one drift case in `bindingDrift.test.ts` using `createAdapterRegistry()`.

`adapterRegistry.test.ts` already guards factory ↔ spec parity — you do not edit it per agent.

## Drift / profiles / IPC

No extra wiring: `applyBinding`, binding profiles, drift UI, and `binding-applied.json` are
agent-agnostic once the adapter exists. Details: `agent-binding-drift.md`.

## Review checklist

1. Are all writes confined to paths declared in `AGENT_SPECS.binding.files`?
2. Do `writeLive` and `readLiveBinding` agree on URL, model, and token presence?
3. For additive agents, is the provider slug `aiopt-<providerId>` and is `providerId` recorded on apply?
