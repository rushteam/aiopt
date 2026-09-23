// The two file primitives every file-backed store under userData needs: a write that cannot leave
// a half-written file behind, and a read that does not trip over a byte-order mark.
//
// Both exist because stores got them wrong one at a time. secretStore wrote `<key>.enc` in place,
// so a crash or a full disk mid-write left truncated ciphertext; `get()` then failed to decrypt,
// returned null, and the provider key was gone with nothing said. configStore wrote
// `preferences.json` the same way. On the read side, `JSON.parse` throws on U+FEFF, and every
// store's load treats a parse failure as "no file": a BOM that Notepad or PowerShell 5.1 left in a
// hand-edited `providers.json` made the whole provider list vanish, and `proxy.json` came back as
// a fresh port with new route tokens that every proxied agent then got a 401 for.
// providers/fsutil.ts `readJsonObject` strips a BOM for agent config files for the same reason.

import fs from 'node:fs';
import path from 'node:path';
import { renameSyncWithRetry } from './fsRetry';

/**
 * Write `contents` to `filePath` via a sibling temp file + rename, so a reader only ever sees the
 * old file or the complete new one. Creates the parent directory. On failure the temp file is
 * removed (best-effort) and the original error is rethrown; the previous `filePath` is untouched.
 *
 * The temp holds exactly what `filePath` would, so callers must only pass contents that are safe
 * to leave in that directory — for secretStore that is ciphertext, never plaintext.
 */
export function writeFileAtomicSync(filePath: string, contents: string | Buffer): void {
  const tmp = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tmp, contents);
    renameSyncWithRetry(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup; preserve the original write error.
    }
    throw err;
  }
}

/** Read `filePath` as UTF-8 with a single leading BOM removed. Throws like `fs.readFileSync`. */
export function readUtf8WithoutBom(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
}
