# Auto-update

> **Status:** authoritative development rule — **high-risk module**
> **Read before:** touching the update provider, the update service, or wiring any real
> update feed / downloader / installer.

The updater is the one subsystem that can silently replace the code every other safeguard
protects. A compromised or careless update path defeats CSP, Fuses, the IPC boundary, and the
secret store all at once, on every user's machine, with no further interaction. Treat it as the
highest-blast-radius change in the repo.

## 1. What the framework ships

- A **provider seam** (`main/update/updateProvider.ts`): one method, `checkForUpdates(current)`,
  that answers "is there a newer version?" — it does **not** download or install anything.
- A **local stub** (`localStubUpdateProvider.ts`) that always reports `up-to-date`. This is the
  default; the framework has **no real update feed**.
- An **update service** (`updateService.ts`) modelling only the `check → notify` flow (idle →
  checking → up-to-date / update-available / error), broadcast to the renderer.

That is the entire shape. Downloading, signature verification, and install-on-quit are
deliberately absent.

## 2. The gate (do not skip)

Wiring a **real** update mechanism — a release feed, `electron-updater`, a downloader, an
installer, install-on-quit — is a **gated change**. It ranks with a framework/architecture
change:

- It must be confirmed by the repo's designated gatekeeper **specifically for the updater**,
  before merge. Not judged by diff size, not waived by who authored it — author identity is not
  an exception.
- Open a change that states, explicitly: the update source and how its transport is
  authenticated, how artifacts are **code-signed and verified before execution**, the rollback
  story, and how a malicious or downgraded artifact is rejected.
- An agent that discovers a task requires a real update path **stops and surfaces the risk**
  first (per the safety floor in `AGENTS.md`); it does not quietly implement it.

## 3. Non-negotiables for any real implementation

- **Verify before execute.** An update artifact runs only after its signature is validated
  against a pinned key. No signature, no run — fail closed.
- **Authenticated transport.** Fetch update metadata and artifacts over TLS from a pinned
  origin; never over plaintext or an attacker-influenceable channel.
- **No downgrade.** Reject artifacts older than or equal to the running version unless an
  explicit, signed rollback directive says otherwise.
- **Renderer stays untrusted.** The renderer may *request* a check and *observe* status; it
  must never choose the update source, hand over an artifact, or trigger an install of
  arbitrary content. All authority stays in main, behind the trusted-sender + validation gate.
- **No secrets in status.** The `UpdateStatus` crossing IPC carries versions and a state only —
  never tokens, URLs with credentials, or signing material.

## Review checklist

1. Does this change introduce (or move toward) a real feed / download / install path? If so, has
   the updater gate in §2 been satisfied with an explicit gatekeeper sign-off?
2. Is every artifact signature-verified against a pinned key before anything executes?
3. Is the transport authenticated and the origin pinned, with downgrades rejected?
4. Does the renderer remain unable to choose the source or trigger an arbitrary install?
5. Is the broadcast/IPC status free of any secret or credential-bearing URL?
