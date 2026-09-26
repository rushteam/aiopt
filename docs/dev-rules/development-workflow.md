# Development workflow

> **Status:** authoritative development rule
> **Read before:** working in an isolated worktree/branch, preparing a commit or direct push,
> or doing code review.

## 1. Isolation

- Reuse the branch or worktree the host already put you in; don't nest a new one inside it.
- When there's no isolation yet, a new feature may get its own branch or worktree — but never
  move, mix, or overwrite an existing working area, and never use destructive Git commands on
  someone else's uncommitted work.
- Confirm branch, worktree, and working-tree status before you start.

## 2. Pre-commit gate (hard requirement)

Whether you're opening a PR or committing directly, **before every commit**:

1. Run the full unit suite from the repo root: `pnpm test:unit`.
2. For each package your change touches, run
   `pnpm --filter <package> run --if-present typecheck` (using the package's `name`; packages
   with no `typecheck` script are skipped automatically).

All must pass before you commit. Any failure blocks the commit — fix it first. The **only**
exception is a data-loss-prevention emergency save (e.g. persisting a user's in-progress work
before a crash); document it in the commit message when you take it.

On top of the gate, add verification proportional to risk — cross-module, high-risk, or
infrastructure changes warrant broader runs (`pnpm test:all`), with CI as the final gate. Never
make the gate pass by skipping, deleting, or weakening tests.

**CI runs the same gate.** `.github/workflows/ci.yml` runs on every pull request (and on pushes
to `main`) and is the authority: `pnpm test:unit`, `pnpm -r run --if-present typecheck`,
`pnpm check:i18n-glossary`, and — on pull requests only — `pnpm check:dco`. Running the gate
locally is still required; CI exists so a forgotten local run cannot land. It is one Linux job,
not a matrix: this is the unit tier, and the suite takes platform as an injected value rather
than reading `process.platform` ambiently, so it is platform-independent. Cross-platform builds
are covered separately by `release.yml` on a version tag.

## 3. DCO sign-off (hard requirement)

Every commit carries a `Signed-off-by` trailer whose name and email match the commit author (or
committer). Use `git commit -s`, or install the hook once with `pnpm dco:install-hook`. Self-check
with `pnpm check:dco`; the PR's DCO check is authoritative. See `CONTRIBUTING.md` for fixing a
missing sign-off. Note that a code-review sandbox may check out a synthetic HEAD SHA that doesn't
exist in the repo; a `check:dco` failure on such a synthetic SHA is not evidence of a missing
sign-off — judge by the DCO App check over the real `origin/main..PR-head` range.

## 4. PR-first delivery

Code and docs normally reach `main` through a PR from a non-default branch; only a maintainer
may choose to direct-push. Fill in `.github/PULL_REQUEST_TEMPLATE.md` honestly — real
verification, and what you did *not* verify.

## 5. Code review severity

Rank findings so attention goes where it matters:

- **P0 — must fix before merge:** breaks the security boundary (§ security rule), loses/corrupts
  user data, edits a frozen migration, leaks a secret, or breaks the build/gate.
- **P1 — should fix:** real bug, missing runtime validation, missing test for a new boundary,
  regression risk.
- **P2 — optional:** style, naming, minor simplification.

Do not report a P0/P1 you haven't actually reproduced or traced; state confidence honestly.

## 6. Releasing (version + tag)

`release.yml` builds installers on all three platforms when a `v*` tag is pushed, and attaches
them to a **draft** GitHub Release for a human to review and publish. It is a download channel,
not an auto-update feed — see `updater.md`.

The version lives in two manifests, `package.json` and `apps/desktop/package.json`, and they
must agree with each other and with the tag. Electron reads the packaged
`apps/desktop/package.json` for installer filenames and for the `app.getVersion()` the About
page shows; it never reads the tag. So a tag that disagrees produces a Release whose name and
whose contents state different versions, and the build itself cannot tell.

`pnpm check:version` enforces this. CI runs it on every PR (manifests agree), and `release.yml`
runs it before building (tag matches too), so the mismatch fails the run instead of shipping.

To release:

1. Bump the version in both manifests, commit (signed off), and land it through a PR.
2. `pnpm check:version --tag v<version>` — the same check the release run will do.
3. Tag the merge commit on `main` and push the tag: `git tag -a v<version> -m '…' && git push
   origin v<version>`.
4. Review the draft Release's assets, then publish it.
5. The Homebrew cask follows on its own. `rushteam/homebrew-tap` runs a sync workflow every
   six hours (or on demand: Actions → Sync AiOpt cask → Run workflow). It reads the latest
   published Release, downloads `AiOpt-<version>-arm64.dmg`, and checks its sha256 against
   GitHub's asset digest. It then rebuilds `Casks/aiopt.rb` from `packaging/homebrew/aiopt.rb`
   on `main` here and runs `brew style`, `brew audit --cask --strict --online`, and a real
   install. A change of only `version` and `sha256` is committed to the tap's `main` directly.
   Any other difference opens a pull request in the tap for review. The cask is the primary
   macOS install route: `brew install --cask rushteam/tap/aiopt`.

   So change the cask's structure (url, postflight, zap, caveats) here, through a PR. The
   `version` and `sha256` in this repository's copy may lag the tap and need no bump. Drafts
   and prereleases are never picked up, and a Release older than the tap's version is
   ignored.

Builds are **unsigned** — macOS Gatekeeper and Windows SmartScreen warn on first launch. Signing
is a follow-up that plugs into the `make` step via secrets; until then, say so wherever the
download is offered. The Release body in `release.yml` carries the macOS "damaged" fix.

The cask's postflight clears the quarantine flag Homebrew sets on the download, which is what
lets an unsigned build launch without a Gatekeeper prompt. That is a Gatekeeper bypass: it is
acceptable only in our own tap, never in a submission to official `homebrew/cask`, and it is to
be removed once the builds are signed and notarized.
