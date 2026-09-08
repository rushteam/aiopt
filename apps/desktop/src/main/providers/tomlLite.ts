// Minimal TOML emitter for the few fixed-shape config files we write (Codex,
// Grok). We deliberately do NOT add a TOML dependency: the documents we emit are
// small and their shapes are known, and the string-escaping rule is the same one
// cc-switch uses — TOML basic strings share JSON's escape set for the characters
// that occur in these values (URLs, model ids, display names), so JSON.stringify
// produces a valid TOML basic string. This is an EMITTER only, not a parser: the
// adapters that use it overwrite the whole file (matching cc-switch's on-disk
// switch behavior), so there is no existing-document merge to preserve.

/** Escape a string as a TOML basic string (same escapes as JSON for our inputs). */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** A scalar TOML value: string → basic string, number/boolean → literal. */
export function tomlValue(value: string | number | boolean): string {
  if (typeof value === 'string') return tomlString(value);
  return String(value);
}

/** `key = value` line with a TOML-encoded value. */
export function tomlLine(key: string, value: string | number | boolean): string {
  return `${key} = ${tomlValue(value)}`;
}

/**
 * A `[table.name]` header where `name` is a bare key when it is a safe bare-key
 * token, or a quoted key otherwise (e.g. a model id containing `/` or `.`).
 */
export function tomlTableHeader(...segments: string[]): string {
  const encoded = segments
    .map((seg) => (/^[A-Za-z0-9_-]+$/.test(seg) ? seg : tomlString(seg)))
    .join('.');
  return `[${encoded}]`;
}
