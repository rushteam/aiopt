# AiOpt: Agent working entry point

> This file is the canonical project instruction shared by all coding agents (Codex, Claude
> Code, etc.). `CLAUDE.md` contains only `@AGENTS.md` — do not duplicate rules in two places.
>
> AiOpt is a **security-first Electron desktop app framework scaffold**. It ships the
> primitives — untrusted renderer / minimal preload / privileged main, IPC as the
> authorization boundary, runtime validation, CSP/Fuses, local DB migrations, layered config,
> i18n + glossary gate, and DCO + test gates — wired end-to-end through one vertical-slice
> demo. Build real features by copying the shape of that slice.

## Repository boundaries

- This repo is the desktop framework scaffold and its shared packages. There is no business
  domain here on purpose; keep it that way.
- Before starting, check the working tree and the relevant source. Do not overwrite or revert
  changes a developer already has in progress.

## How the rules are organized

- Engineering and development rules live in `docs/dev-rules/`.
- UI visual / interaction / content rules live in `docs/design-rules/`, with the authoritative
  spec in `docs/design-rules/DESIGN.md`.
- This root `AGENTS.md` keeps only rules that apply to every task, the safety floor, and the
  index below. Directory- or module-specific rules belong in a nested `AGENTS.md` in that
  directory.

## Current rule index (read the rule before you touch the area)

- First contact with this repo, or locating where code lives / where new code belongs: read
  `docs/dev-rules/repo-map.md`.
- Before modifying the renderer, preload, BrowserWindow, WebView, IPC, CSP, navigation, or any
  Electron privileged capability: read
  `docs/dev-rules/electron-security-and-process-boundaries.md`.
- Before changing how credentials / tokens / auth data are handled, where files are written,
  user-persistent data, temp files, or test directories: read
  `docs/dev-rules/credentials-and-local-storage.md`.
- Before changing the SQLite schema, a migration, or runtime DB access: read
  `docs/dev-rules/database-and-migrations.md`.
- Before touching the update provider / service, or wiring any real update feed, downloader,
  or installer: read `docs/dev-rules/updater.md`. **The updater is a high-risk module**; a real
  update path is a gated change requiring the gatekeeper's explicit sign-off (not judged by diff
  size or author).
- Before changing package dependency direction, how the main process loads modules, or the
  main layout tree structure: read `docs/dev-rules/architecture-invariants.md`.
- Before adding/altering Settings UI, config files, local preferences, or runtime profiles:
  read `docs/dev-rules/configuration-and-overrides.md`.
- Before adding/changing Desktop logging, IPC error handling, main-side logic and tests,
  cross-platform (macOS/Windows) behavior, or the i18n landing of any UI text: read
  `docs/dev-rules/engineering-conventions.md`.
- Before adding or modifying any UI, component, layout, style, motion, or UI copy: read the
  authoritative spec `docs/design-rules/DESIGN.md`.
- Before adding or changing a **product term** in any UI copy: check `i18n/GLOSSARY.md` first.
  Use decided terms as written; for a missing or uncertain term, add a `"status": "proposed"`
  entry to `i18n/glossary.json` and discuss. The gate is `pnpm check:i18n-glossary`.
- Working inside a worktree/branch, preparing to commit or push, or doing code review: read
  `docs/dev-rules/development-workflow.md`.
- Before bumping the app version, pushing a `v*` tag, or changing `release.yml`: read
  `docs/dev-rules/development-workflow.md` §6. The version lives in two manifests and must match
  the tag; the gate is `pnpm check:version`.

## General workflow

1. Confirm the goal, the repo boundary, the current branch, and the working-tree state.
2. Respect the Git workflow the developer or host already set up. Reuse an existing task branch
   or worktree; do not nest or mix work into someone else's workspace.
3. Read the relevant rules in `docs/dev-rules/` and `docs/design-rules/` for the task type.
4. Read the actual code and tests before deciding an implementation — do not guess from docs.
5. Keep the change scope minimal, protect in-progress work, and use no destructive Git commands.
6. Run the checks that match the risk, and review the whole diff before finishing.
7. Report honestly what was verified, what was not, the risks, and what needs a human decision.

## Git & delivery

- PR-first by default. Code and docs reach `main` through a PR from a non-default branch;
  direct pushes to the trunk are only for a maintainer who explicitly chose that exception.
- **DCO sign-off (hard requirement):** every commit must carry a `Signed-off-by` trailer whose
  name and email match the commit author (or committer). Use `git commit -s`; automated agent
  commits are no exception. The PR's DCO check (config in `.github/dco.yml`) blocks unsigned
  commits. `git commit` has no auto-sign-off setting — install the hook once with
  `pnpm dco:install-hook`, and self-check before committing with `pnpm check:dco`. Full text is
  in `DCO`; contributor guidance is in `CONTRIBUTING.md`.
- **Pre-commit test gate (hard requirement):** before any commit or PR, run the root
  `pnpm test:unit` (all unit tests) and, for each package your change touches, run
  `pnpm --filter <package name> run --if-present typecheck`. All must pass before committing;
  fix any failure first. Do not fabricate a pass by skipping, deleting, or weakening tests.
- Add verification proportional to risk on top of that gate. CI is the final authority.

## Absolute safety floor

- User credentials, tokens, auth files, and keys must never be written into the repo or any
  path that could be tracked by Git.
- Do not perform destructive or hard-to-reverse operations (deleting data, overwriting changes,
  pushing, publishing, merging) without the user's explicit authorization.
- When a task would touch the security boundary (process boundaries / IPC authorization / CSP /
  Fuses), credential handling, DB history migrations, or user-data safety: stop, re-read the
  specific rule, and state the risk (or ask for confirmation) before acting.
