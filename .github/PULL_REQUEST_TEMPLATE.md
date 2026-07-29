<!--
  Describe the change honestly: what it does, how you verified it, and what remains at risk.
  Every commit must carry a DCO Signed-off-by trailer (git commit -s) whose name and email
  match the commit author — the DCO check will block the PR otherwise. See CONTRIBUTING.md.
-->

## What & why

<!-- What does this change do, and why is it needed? -->

## Security-boundary checklist

Tick only what genuinely applies. If your change touches any of these, say how you kept the
invariant (see docs/dev-rules/electron-security-and-process-boundaries.md).

- [ ] No new privileged capability is reachable from the renderer without an authorized IPC handler.
- [ ] New IPC handlers assert a trusted sender **and** validate every payload field at runtime (TS types are not runtime checks).
- [ ] No credential, token, or secret is written to a git-tracked path (see credentials-and-local-storage.md).
- [ ] CSP / navigation / window-open guards were not weakened; any change to them is called out below.
- [ ] New user-facing text goes through i18n, and product terms match i18n/GLOSSARY.md.

## Verification

<!-- Which of these did you run, and what was the result? Report failures and skips honestly. -->

- [ ] `pnpm test:unit`
- [ ] `pnpm --filter <affected package> run --if-present typecheck`
- [ ] `pnpm check:dco`
- [ ] `pnpm check:i18n-glossary`
- [ ] `pnpm dev` — the vertical-slice demo still works end to end

## Risk & follow-ups

<!-- What could this break? What did you not verify? What is deferred? -->
