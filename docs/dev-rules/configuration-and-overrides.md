# Configuration & overrides

> **Status:** authoritative development rule
> **Read before:** adding/changing settings UI, config files, local preferences, a runtime
> profile, or a provider/capability toggle.

Configuration is layered so that shipping a new default never overwrites a choice the user
made, and "restore default" always works.

## 1. Layering (lowest to highest precedence)

1. **Built-in defaults** — shipped with the app, the source of truth for every setting's shape
   and default value.
2. **User overrides** — persisted separately, containing *only* the keys the user has changed.
3. **Environment / launch overrides** — highest precedence, for dev and CI; not persisted.

The effective config is the deep-merge of these layers in order.

## 2. Rules

- **Persist only the overrides, never the merged result.** If you write the full resolved config
  back to disk, then every default becomes frozen at its value on the day the user first touched
  settings — a later app version can never move that default. Store the diff from defaults.
- **"Restore default" = delete the override key**, not "write today's default value." Deleting
  re-exposes the setting to future default changes; writing pins it.
- A setting has exactly one home. Do not read the same concept from two places that can drift.
- Adding a setting means: add its default, its type/validation, and its migration/back-compat
  handling for configs written by older versions. Unknown keys in a user's override file are
  preserved, not dropped, so a downgrade-then-upgrade doesn't lose them.
- Validate config at load with the same rigor as an IPC payload; a malformed or hand-edited
  file must fail closed to defaults, not crash or half-apply.

## 3. Visibility

- Hiding or disabling a control in settings is a UX affordance, **not** a permission or security
  boundary — the enforcing check lives in main (see the security rule, §1/§5).

## Review checklist

1. Does this persist only the user's overrides, or does it write back the merged config?
2. Does "restore default" delete the override key rather than writing a value?
3. Are unknown/older-version keys preserved on save, and does a bad file fail closed to defaults?
