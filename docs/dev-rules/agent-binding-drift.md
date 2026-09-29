# Agent binding drift

> **Status:** authoritative development rule
> **Read before:** changing `applyBinding`, agent adapters, or the Providers agent card drift UI.

When AiOpt binds an agent to a provider, it writes that agent's **native** config files under
`$HOME` (or `AIOPT_AGENT_HOME` in tests). It also records a compact snapshot in userData:

| File | Contents |
| --- | --- |
| `binding-applied.json` | Per agent: last `baseUrl`, `modelId`, whether a token/key was written, `providerId`, `appliedAt` |
| `binding-profiles.json` | Named snapshots of in-app bindings (not a second copy of agent files) |

**Drift** means: the user (or another tool) changed those agent files so they no longer match
the snapshot from the last successful `applyBinding` / re-sync. The renderer shows a warning and
offers **Re-sync config** (`providers:resync-binding` → replay `applyBinding`).

## Why not one generic drift checker?

Agents do not share one on-disk schema. Claude uses JSON `env`; Codex uses TOML + `auth.json`;
dsh/Hermes use YAML merge targets; pi/OpenCode use additive JSON maps keyed by `aiopt-<providerId>`.
Gemini uses a flat `.env`. Grok overwrites a TOML profile table.

The **comparison** is unified (`baseUrl`, `modelId`, `authTokenSet`, optional `compareModel: false`
for agents that do not persist the active model). The **readback** is not — each adapter implements
`readLiveBinding(applied)` next to `writeLive`, using the same paths and field names it writes.

Shared helpers (TOML table scrape, `.env` parse, URL normalize, compare) live in
`main/providers/adapters/bindingLive.ts`. Do not duplicate write paths in a central switch; add or
adjust readback on the adapter that owns the write.

## Adding a new bindable agent

Follow `add-bindable-agent.md` (three steps: `AGENT_SPECS`, adapter module, one registry key).
Ship `writeLive` + `readLiveBinding` together; drift needs no separate wiring.

## Review checklist

1. Does `readLiveBinding` inspect only allowlisted paths (`agentPaths.ts`)?
2. Does drift avoid reading or returning secret **values** over IPC (boolean `authTokenSet` only)?
3. After a proxied binding, does readback compare the **loopback** URL/token presence AiOpt wrote?
