// Per-provider outbound request sanitizing — stripping fields an upstream rejects.
//
// WHY THIS EXISTS: a same-format proxy route is an identity passthrough (see
// IDENTITY_TRANSFORMS in translationProxy.ts) — the agent's body is forwarded verbatim.
// When the upstream is a gateway that VALIDATES rather than ignores unknown fields, one
// stray field fails the whole call: an OpenAI-shaped client sends `store`, a LiteLLM →
// Bedrock deployment refuses the parameter, and the agent sees a 400 it cannot fix from
// its own config. `Provider.dropRequestFields` lets the user name those fields per
// provider; this module applies them.
//
// SCOPE — it strips TOP-LEVEL fields only, and only ones on the shared allowlist
// (`DROPPABLE_FIELD_NAMES`). It never reaches into `messages`/`input` content, and it
// cannot touch `tools`, `tool_choice`, `messages` or `model`, because those names are
// absent from the allowlist and `normalizeDropFields` discards anything not on it. So a
// hand-edited providers.json cannot turn this into a silent tool-stripper.
//
// RELATIONSHIP TO THE TRANSLATORS: a CROSS-format route rebuilds the body from a
// whitelist of known fields, so an unknown field is already gone before this runs; what
// the translators do instead is REFUSE a known-but-untranslatable field
// (UNSUPPORTED_REQUEST_FIELDS in translate/types.ts) precisely because silently dropping
// it would change semantics behind the user's back. This module does not overrule that:
// it runs AFTER translation, so a cross-format route still gets its explicit 400 unless
// the user opted that field in. Configuring a field here is the user's way of saying
// "I know, this upstream leaves me no choice."
//
// Pure (no I/O, no Electron) so it unit-tests directly; the logging of what was stripped
// is the caller's job — field NAMES are safe to log, values are not (they can be
// arbitrary user content, and this runs on the credentialed request path).

import { normalizeDropFields } from '../../shared/aiProviders';

/** What a sanitize pass removed — field names only, for the caller's structured log. */
export interface SanitizeResult {
  /** The body to forward. The same object reference when nothing was stripped. */
  body: Record<string, unknown>;
  /** Names of the fields actually present and removed, in allowlist order. */
  dropped: string[];
}

/**
 * Strip a provider's configured `dropRequestFields` from an outbound body.
 *
 * Only fields that are BOTH configured and actually present are reported as dropped, so a
 * caller's log records what really changed on the wire rather than what was configured.
 * Copies the body only when there is something to strip (the overwhelmingly common case
 * is an empty config, which must stay allocation-free on the hot request path).
 *
 * `dropFields` is re-normalized here rather than trusted: this is the last step before a
 * credentialed upstream call, and the allowlist is the thing standing between a corrupted
 * persisted value and a stripped `tools` array. Validating at both the store boundary and
 * here is deliberate — the request path does not depend on an earlier caller having done it.
 */
export function sanitizeOutboundBody(
  body: Record<string, unknown>,
  dropFields: readonly string[] | undefined,
): SanitizeResult {
  if (!dropFields || dropFields.length === 0) return { body, dropped: [] };

  const allowed = normalizeDropFields(dropFields);
  // Strip a field only when it is actually carried. `null` counts as present: an upstream
  // that rejects `store` rejects `store: null` too — it is the key that offends, not the value.
  const dropped = allowed.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (dropped.length === 0) return { body, dropped: [] };

  const next = { ...body };
  for (const field of dropped) delete next[field];
  return { body: next, dropped };
}
