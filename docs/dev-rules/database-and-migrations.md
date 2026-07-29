# Local database & migrations

> **Status:** authoritative development rule
> **Read before:** changing the database schema, a migration, a companion script, or
> runtime database access.
>
> The concrete DB code (`localDb/*`, `drizzle/*`) lands in a later scaffold stage. This
> document fixes the invariants that code must obey the moment it exists.

The database holds user data that cannot be regenerated. A bad migration on a machine you can't
reach is unrecoverable, so the rules here are conservative on purpose.

## 1. The append-only freeze (the one that matters)

- **A migration that has reached `main` is frozen. Never edit, reorder, renumber, or delete
  it.** Someone has already run it; rewriting it makes their schema silently diverge from the
  version chain.
- To change the schema, **add the next migration.** Corrections happen forward, never by
  rewriting history.
- The version chain is linear and monotonic (`0000_…`, `0001_…`, …). A `migration_meta` table
  records which versions have been applied.
- A freeze guard test pins the content hash of every already-released migration; the test fails
  if a historical file changes. This is the mechanical backstop for the rule above.

## 2. Standard flow for a schema change

1. Edit the schema definition (`localDb/schema.ts`).
2. Generate the next migration with drizzle-kit; **never** hand-edit or fold it into an existing
   file.
3. Review the generated SQL — a generator can emit a destructive `DROP`/rebuild. Confirm it does
   what you intend before it becomes part of the frozen chain.
4. Run the migration replay test tier against a fresh database.
5. Land schema + migration + tests together.

## 3. Runtime access & safety

- Apply pending migrations at a single, controlled point in startup — not lazily from scattered
  call sites.
- **Back up before applying** a migration; **roll back (or refuse to start) on failure** rather
  than leaving a half-migrated database. Never "best-effort continue" past a failed migration.
- Route runtime access through one DB client module; do not open ad-hoc connections elsewhere.
- Companion/maintenance scripts obey the same freeze and backup rules as the app.

## Review checklist

1. Does this change edit any migration already on `main`? (It must not.)
2. Is the schema change expressed as the next migration, with the freeze-guard test still green?
3. Does the generated SQL do anything destructive you didn't intend?
4. Is there a backup-before-apply and a defined failure path (rollback / refuse start)?
