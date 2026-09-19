# Credentials & local storage

> **Status:** authoritative development rule
> **Read before:** touching credential/token/authorization handling, where files land on
> disk, user-persistent data, temp files, or test directories.

Secrets and user data are the assets an attacker wants. Two mistakes dominate: writing a secret
somewhere Git can track it, and scattering user data so it can neither be found nor cleaned up.

## 1. Credentials must never reach a git-tracked path

- User credentials, tokens, authorization files, and keys **must not** be written into the
  repository or any path that could be tracked by Git — not under `apps/`, not under a
  `.local` file that isn't ignored, not into a fixture.
- Secrets at rest go through the OS-backed secret store (`security/secretStore.ts`, a wrapper
  over Electron `safeStorage`) and land only under the per-user application data directory.
  Plaintext secrets never transit the preload or the renderer.
- `.env*` files are git-ignored except a committed `.env.example` with placeholder values only.
- Logs, IPC errors, and error reports must never contain a plaintext secret, token, or full
  credential. Mask before you log (see `engineering-conventions.md` §1).

## 2. Know where each kind of data lives

Pick a location by *lifecycle*, and never hard-code an absolute path — always derive from
Electron's `app.getPath(...)`:

| Data | Location | Lifecycle |
| --- | --- | --- |
| App config / user preferences | `app.getPath('userData')` | Survives restart & update; user-owned. |
| Proxy identity (`proxy.json`: loopback port + per-binding route tokens) | `app.getPath('userData')` | Survives restart so a running agent's cached loopback config keeps working; user-owned. Route tokens are secret-class loopback credentials (NOT the real provider key, which stays in the OS secret store) — never log them; rotated only on rebind/clear. |
| Local database | `app.getPath('userData')` | Long-lived; migrated, never silently reset. |
| Secrets | OS secret store, keyed under `userData` | Long-lived; encrypted at rest. |
| Caches / rebuildable artifacts | `app.getPath('cache')` | Disposable; must be safe to delete. |
| Transient scratch | `app.getPath('temp')` | Per-run; clean up on exit. |
| Logs | `app.getPath('logs')` | Rotating; masked; no secrets. |

- Rebuildable data goes in a cache/temp location, not next to source-of-truth data, so clearing
  it can never corrupt real state.
- When adding a new persisted location, decide its lifecycle first, then document it in the
  table so cleanup and backup logic know it exists.

## 3. Tests

- Tests write only under a temp directory they create and remove; they never touch the real
  `userData` and never write a real credential.
- Fixtures use obvious placeholders, never a real token shaped to "look realistic."

## Review checklist

1. Could any secret this change handles end up on a git-tracked path or in a log?
2. Is every new on-disk path derived from `app.getPath(...)` with a documented lifecycle?
3. Do secrets stay in main / the secret store, never crossing into preload or renderer?
