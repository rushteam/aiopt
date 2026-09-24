// A source file must not contain a raw control byte.
//
// This exists because one did: SkillsHome.tsx carried a literal U+0000 inside a template
// string (a cache-key separator) for two commits. It compiled and behaved correctly, but a
// NUL makes the whole file BINARY to the standard toolchain — `grep` silently skips it, so
// every symbol in a 1,196-line file was invisible to search, and `git diff` would have
// refused to show it as text. A separator like that belongs in the source as the escape
// `\u0000`, which produces a byte-identical string with none of the fallout.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `fileURLToPath`, not `URL#pathname`: on Windows the pathname is `/D:/a/...`, which Node
// resolves against the current drive into `D:\D:\a\...` and the scan fails with ENOENT.
// It also decodes percent-escapes, so a checkout path with a space works on every platform.
const SRC = fileURLToPath(new URL('../../', import.meta.url));

/** Every .ts/.tsx source file under src/, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe('source hygiene', () => {
  // Tab and newline are legitimate; a carriage return is tolerated for CRLF checkouts.
  // Everything else below 0x20 has no business in a source file.
  const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

  it('no source file contains a raw control byte', () => {
    const offenders = sourceFiles(SRC)
      .map((file) => ({ file, match: FORBIDDEN.exec(readFileSync(file, 'utf8')) }))
      .filter((r) => r.match)
      .map((r) => {
        const codePoint = r.match?.[0].codePointAt(0) ?? 0;
        return `${r.file.slice(SRC.length)} contains U+${codePoint.toString(16).padStart(4, '0').toUpperCase()}`;
      });
    expect(offenders).toEqual([]);
  });
});
