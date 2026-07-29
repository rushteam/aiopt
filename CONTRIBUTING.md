# Contributing to Hearth

Thanks for contributing. Two things are non-negotiable: the **security boundary** (see
`docs/dev-rules/electron-security-and-process-boundaries.md`) and the **DCO sign-off** below.
Everything else is in `AGENTS.md` and the rules it indexes.

## Developer Certificate of Origin (DCO)

Every commit must carry a `Signed-off-by` trailer certifying you have the right to submit the
change under the project's license. The full text is in the [`DCO`](./DCO) file at the repo
root. The trailer looks like:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email must match the commit's author (or committer).

### Signing off

- **Every commit:** `git commit -s` appends the trailer using your Git identity.
- **Automatically, forever:** run `pnpm dco:install-hook` once. It installs
  `.githooks/prepare-commit-msg`, which appends the trailer to every local commit (including
  automated agent commits). Delete the installed file to uninstall.
- **Check before pushing:** `pnpm check:dco` verifies the commits your branch introduces. The
  authoritative gate on the PR is the [DCO GitHub App](https://github.com/apps/dco), configured
  in `.github/dco.yml`.

### Fixing a missing sign-off

```sh
# the most recent commit only
git commit --amend -s --no-edit

# several commits (rebase the range your PR introduces)
git rebase --signoff <base>

# then update the PR
git push --force-with-lease
```

`.github/dco.yml` enables **remediation commits**, so you may instead push a follow-up commit
that signs off earlier commits without rewriting history — handy when a force-push would mark
existing review comments as outdated.

## Before you open a PR

Run the same gate the commit rule requires, plus anything your change's risk warrants:

```sh
pnpm test:unit
pnpm --filter <affected package> run --if-present typecheck
pnpm check:dco
pnpm check:i18n-glossary
```

Then fill in `.github/PULL_REQUEST_TEMPLATE.md` honestly — including the security-boundary
checklist and what you did *not* verify. Do not make the gate pass by skipping, deleting, or
weakening tests.
