# Engineering conventions

> **Status:** authoritative development rule
> **Read before:** adding/changing logging, IPC error handling, main-side business logic and
> its tests, cross-platform (macOS/Windows) behavior, or landing i18n copy.

## 1. Logging

- Use the structured logger (`main/logger.ts`), not bare `console.*`, for anything that should
  survive into a log file. Emit structured events (a stable event name + fields), not
  interpolated prose — structured logs are greppable and safe to redact.
- **Never log a secret, token, full credential, or raw absolute path.** Mask before logging:
  `maskPath` reduces a path to a non-identifying shape, `maskEmail` keeps only enough to
  correlate. When in doubt, log an id or a masked form, not the value.
- Log levels: `error` for a failure needing attention, `warn` for a recovered/degraded path,
  `info` for lifecycle milestones, `debug` for development detail. Don't log at `info` inside a
  hot loop.

## 2. IPC error handling

- Every IPC handler returns errors through the unified protocol (`shared/ipc-errors.ts`): a
  typed `code`, a safe message, and optional structured detail. Use `throwIpcError(code, …)`.
- The message and detail crossing to the renderer must be safe to show: **no stack traces, no
  credentials, no internal absolute paths, no verbatim upstream error bodies.** Log the rich
  detail in main; return the sanitized shape to the renderer.
- Codes are generic and reusable (`INVALID_PARAMS`, `NOT_FOUND`, `INTERNAL`, `ALREADY_EXISTS`,
  `PRECONDITION_FAILED`, `PERMISSION_DENIED`, `UNSUPPORTED_CAPABILITY`). Don't invent a
  per-feature code where a generic one fits; if a genuinely new *category* is needed, add it to
  the shared union with tests, don't stuff it into a message string.

## 3. Cross-platform

- Main-side business logic that touches paths, shells, or OS integration must work on both
  macOS and Windows. Use `path` APIs, never hand-built separators; don't assume a POSIX shell.
- Gate genuinely platform-specific behavior on `process.platform` and keep the branches beside
  each other. Note in the PR which platforms you actually ran on and which you only reasoned
  about.

### 3.1 Make the Windows behaviour assertable, not just correct

A Linux-only PR gate cannot notice a POSIX assumption. Both were true here at once: the code
assumed POSIX, and the test could not have said otherwise. So the rule is not only "use `path`
APIs" — it is **take the platform as a parameter wherever behaviour is path- or platform-shaped**,
so a macOS or Linux runner can assert the Windows semantics.

- Inject a `path` flavour, don't read the separator ambiently. `main/displayPath.ts` takes
  `Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'>` defaulted to `path`; its test passes
  `path.win32` and asserts Windows results on a Linux runner. Same shape as app-shortcuts taking
  `platform` as a value rather than reading `process.platform`.
- Decide path containment with `path.relative`, never ``abs.startsWith(`${base}/`)``. A hand-built
  separator silently stops matching on Windows. Note the two extra cases `relative` gives you:
  an **absolute** result means a different drive, and a leading `..` **segment** means an escape
  (check segment-wise — `..foo` is a legitimate name inside the directory).
- Case-fold a path comparison on `win32` and `darwin`, because NTFS and APFS do, and
  `path.resolve` does not canonicalize case or a drive letter. For an allowlist this is the
  fail-closed direction — it can only accept another spelling of an already-listed path. Do not
  reach for `fs.realpathSync` inside a security check; that buys TOCTOU.
- Commit via temp + rename, and **retry** it. `renameSync` over an existing file does work on
  Windows (libuv uses `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`), but a lock from an agent
  CLI, Defender, an indexer or a backup agent surfaces as EPERM/EACCES/EBUSY and clears within
  milliseconds. Use `main/fsRetry.ts` (`renameSyncWithRetry`, `rmrfSyncWithRetry`) rather than a
  bare call — including in a rollback `catch`, which needs it most. `MoveFileEx`'s
  `REPLACE_EXISTING` does not work for **directories**, so a directory swap must move the old one
  aside first (see `skills/skillsFs.ts` `replaceDir`).
- Strip a BOM before `JSON.parse`. It **throws** on a leading U+FEFF, and a config file a user
  edited in a Windows editor can carry one — with a read-modify-write store that means the parse
  failure is treated as "no config" and the user's other settings are overwritten. (`yaml`'s
  `parseDocument` tolerates a BOM, so the YAML adapters are unaffected.)
- `mode: 0o600` is a **no-op on Windows**. Node's `chmod` only toggles the FAT-era read-only
  attribute, `0o600` has the write bit set, and `mkdir`'s `mode` is ignored outright;
  `statSync().mode & 0o777` reports a synthesised `0o666`. Confidentiality there rests on the
  `%USERPROFILE%` ACL and, for real secrets, on `safeStorage` — never on these bits. Don't assert
  `0o600` unconditionally in a test, and log the gap rather than implying enforcement (see
  `providers/fsutil.ts` `verifyMode` → `config.mode_unenforced`).
- Under `shell: true` (unavoidable when spawning `pnpm`, i.e. `pnpm.cmd`, since Node 18.20.2)
  every argv entry is re-parsed by `cmd.exe` unquoted. Pass a directory as `cwd`, not as an argv
  path — a checkout under `C:\Users\Ada Lovelace\…` splits at the space.
- A test **fixture** can be the thing that fails: `fs.symlinkSync` needs elevation or Developer
  Mode on Windows. Probe the capability and skip with a stated reason rather than deleting the
  coverage, and don't point a fixture at a POSIX system path like `/etc/hosts`.

This matters for releases, not just correctness: `release.yml` runs the unit gate **before**
`electron-forge make`, so a POSIX-only assertion kills the windows-latest leg and ships a Release
with no `Setup.exe` while macOS and Linux publish normally. `fail-fast: false` hides it.

Two things are still only reasoned about, not run on Windows: MAX_PATH behaviour under
`replaceDir`'s longer `.<base>.aiopt-tmp` staging path, and whether OpenCode on Windows reads
`~/.config/opencode` or `%APPDATA%\opencode`.

## 4. Tests

- New main-side logic gets a unit test; a new security boundary gets a regression test that
  fails if the boundary is removed (see the security rule §8).
- Prefer testing the Electron-free abstraction (e.g. the IPC registry, validators, config
  merge) over standing up a real Electron process.

## 5. Internationalization

- User-facing copy goes through i18n; no hard-coded display strings in components. Add every new
  key to each locale in `apps/desktop/src/renderer/i18n/locales/<locale>/common.json`.
- Light + dark are both required for any UI (see `../design-rules/DESIGN.md`); i18n and theming
  are delivery requirements, not follow-ups.

### 5.1 Product-term glossary gate

- Before adding or changing a **product term** in UI copy, check the glossary `i18n/GLOSSARY.md`.
  Use the adjudicated translation as-is; do not coin your own.
- If a term is missing or you're unsure, add it to `i18n/glossary.json` with
  `status: "proposed"` and discuss — don't silently invent a rendering.
- A `decided` term with a `forbidden` list will **fail** the gate if a forbidden rendering
  appears in copy; a `proposed` term only warns. The gate is `pnpm check:i18n-glossary`, and it
  also verifies `GLOSSARY.md` is regenerated from `glossary.json`
  (`pnpm glossary:generate`). The glossary is a reference for correct terms, not a
  find-and-replace target.

## Review checklist

1. Any secret / absolute path / stack trace reachable in a log or an IPC error message?
2. Do IPC errors use the shared protocol with a sanitized renderer-facing shape?
3. Is new copy in every locale, passing the glossary gate, with light + dark both done?
4. Does new main logic (especially a security boundary) have a regression test?
5. Does anything path-shaped take its platform as a parameter, so the Windows behaviour is
   asserted on the Linux gate rather than only reasoned about (§3.1)?
