# Architecture invariants

> **Status:** authoritative development rule
> **Read before:** adding/changing a package's dependency direction, how the main process
> loads modules, or the main layout tree structure.

A few high-blast-radius invariants that are hard to trace once broken. Process
responsibilities and the trust boundary are in
[`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md).

## 1. Package decoupling

- A package is a module that could one day provide its capability standalone. Design and
  implement it decoupled from renderer/main. Anything host-specific (files, network, host
  capability) is injected at init or runtime through an interface/callback.
- A package does not import renderer components, and does not import main (consistent with the
  layering in the security rule, §2).

## 2. Main process static dependencies

- The main process **must not use runtime dynamic `import()`**; use top-level static imports.
  Dynamic import introduces uncertainty in bundling, load timing, and error paths.

## 3. Layout is user-level config

This scaffold does not ship a product's specific layout tree — that is a product decision. It
does keep the *principle* that a real app should follow when it builds one:

- The window layout is **user-level configuration**, not session data. It must be in place
  synchronously with the first frame — never paint a default layout and then jump to the user's.
- Panel identity is by a stable `kind`, never by current position ("left pane" / "right pane"
  is not an identity).
- Unknown, dormant, or detached panels may remain in the persisted layout without rendering;
  restore them in place when re-injected. Do not destroy that position memory by pruning
  unknown kinds.

## Review checklist

1. Does the package use injection rather than importing renderer/main? Any reverse dependency
   on main?
2. Does the main process contain any runtime dynamic `import()`?
3. If a layout tree exists, is it user-level config in place at the first frame, with identity
   by kind and unknown panels preserved?
