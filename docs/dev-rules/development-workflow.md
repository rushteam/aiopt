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
