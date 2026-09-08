// Privileged filesystem core for Skills — the ONLY place skill directories are read, compared,
// copied, and removed. Injected and Electron-free so it is unit-testable against temp dirs.
//
// SECURITY (see docs/dev-rules/electron-security-and-process-boundaries.md and
// credentials-and-local-storage.md): every function takes ALREADY-RESOLVED absolute paths from
// the caller (skillsPaths.ts / the store) — this module never joins a renderer-supplied name.
// A skill copy is treated as inert CONTENT: it is never executed, and only `SKILL.md`'s
// frontmatter is parsed for display text. Copy/overwrite refuses symbolic links outright (a
// skill has no legitimate need for one, and refusing removes every escape-via-link path) and
// enforces hard file-count / byte caps to refuse an absurd or hostile source (e.g. a symlinked
// `~/.ssh` or a runaway tree). Overwrite is atomic (temp + rename, mirroring providerStore's
// write discipline and skills-cli's ReplaceDir): a failure leaves the destination untouched.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { throwIpcError } from '../ipc/validate';
import {
  SKILL_MAX_BYTES,
  SKILL_MAX_FILES,
  type SkillFileContent,
  type SkillFileDiff,
  type SkillMeta,
} from '../../shared/skills';

/** The name of the marker file that makes a directory a skill. */
export const SKILL_MARKER = 'SKILL.md';

/**
 * Injectable filesystem seam. The real implementation wraps `node:fs`; tests point the real one
 * at a temp dir (fs operations are hard to fake faithfully, so we exercise the real code).
 */
export interface SkillsFs {
  /** Immediate subdirectory names of `baseDir` that contain a `SKILL.md`. `[]` if base is absent. */
  listSkillNames(baseDir: string): string[];
  /** Parse `<skillDir>/SKILL.md` frontmatter. `null` when unreadable or it carries no `name`. */
  readMeta(skillDir: string): SkillMeta | null;
  /** Count files and total bytes under `skillDir`. Throws if it exceeds the caps or hits a symlink. */
  measure(skillDir: string): { fileCount: number; totalBytes: number; modifiedAt: number };
  /** True if `skillDir` exists and is a real directory (not a symlink). */
  isSkillDir(skillDir: string): boolean;
  /** True if `<skillDir>/SKILL.md` exists as a regular file (i.e. it is a skill). */
  hasMarker(skillDir: string): boolean;
  /** Per-file diff of `agentDir` against `centralDir` as the source of truth. */
  compare(centralDir: string, agentDir: string): SkillFileDiff[];
  /** True when `compare` would report at least one difference. */
  differs(centralDir: string, agentDir: string): boolean;
  /**
   * Read one file under `skillDir` for a diff preview, capped at `maxBytes`. `relPath` must be a
   * caller-vetted path (a member of a diff computed by main). Refuses a symlink or a path that
   * escapes `skillDir`; returns `text: null` for a binary or absent file.
   */
  readTextFile(skillDir: string, relPath: string, maxBytes: number): SkillFileContent;
  /** Atomically replace `dstDir` with a copy of `srcDir`. Refuses symlinks; enforces caps. */
  replaceDir(srcDir: string, dstDir: string): void;
  /**
   * Atomically rewrite `centralDir` = its own current content with each file in `agentPicks`
   * taken from `agentDir` instead (copied in, or removed when the agent lacks it). Validates both
   * sides (symlinks/caps) first; `agentPicks` must be caller-vetted relative paths.
   */
  mergeInto(centralDir: string, agentDir: string, agentPicks: string[]): void;
  /** Remove `dstDir` and its contents. No-op if absent. */
  removeDir(dstDir: string): void;
}

// --- frontmatter (minimal, no YAML dependency; "good enough" like the i18n runtime) -----------

/**
 * Extract `name` and `description` from a leading `---` frontmatter block. Deliberately tiny: it
 * reads the first fenced block and picks the two scalar keys it cares about. Quotes are trimmed.
 * Anything else in the block is ignored. Not a YAML parser — skills only need these two fields.
 */
export function parseSkillFrontmatter(text: string): SkillMeta | null {
  // Normalise newlines; a BOM would break the opening fence match.
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return null;
  const end = src.indexOf('\n---', 4);
  if (end === -1) return null;
  const block = src.slice(4, end);

  let name: string | undefined;
  let description: string | undefined;
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = (m[2] ?? '').trim();
    // Strip a single pair of surrounding quotes.
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0]!)) {
      value = value.slice(1, -1);
    }
    if (key === 'name' && name === undefined) name = value;
    else if (key === 'description' && description === undefined) description = value;
  }

  if (!name) return null;
  const meta: SkillMeta = { name };
  if (description) meta.description = description;
  return meta;
}

/** True if `buf` looks binary (contains a NUL byte within the sampled prefix). Mirrors skills-cli. */
function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8000);
  for (let i = 0; i < limit; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// --- real implementation -----------------------------------------------------------------------

/**
 * Walk `root` collecting file paths relative to it, refusing any symlink and enforcing the caps.
 * Returns the relative paths so a copier can recreate the tree deterministically. Throws a coded
 * error the moment a symlink is seen or a cap is exceeded — fail-closed, before any write.
 */
function collectFiles(root: string): string[] {
  const rels: string[] = [];
  let bytes = 0;

  const walk = (dir: string, rel: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throwIpcError('PERMISSION_DENIED', `symbolic links are not allowed in a skill: ${childRel}`);
      }
      if (entry.isDirectory()) {
        walk(abs, childRel);
        continue;
      }
      if (!entry.isFile()) {
        // Sockets, FIFOs, devices — refuse anything that is not a plain file.
        throwIpcError('PERMISSION_DENIED', `unsupported file type in a skill: ${childRel}`);
      }
      rels.push(childRel);
      if (rels.length > SKILL_MAX_FILES) {
        throwIpcError('PRECONDITION_FAILED', `skill has too many files (limit ${SKILL_MAX_FILES})`);
      }
      bytes += fs.statSync(abs).size;
      if (bytes > SKILL_MAX_BYTES) {
        throwIpcError('PRECONDITION_FAILED', `skill is too large (limit ${SKILL_MAX_BYTES} bytes)`);
      }
    }
  };

  walk(root, '');
  return rels;
}

/** Copy the files listed in `rels` from `srcDir` into `dstDir`, creating parent dirs as needed. */
function copyFiles(srcDir: string, dstDir: string, rels: string[]): void {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const rel of rels) {
    const from = path.join(srcDir, rel);
    const to = path.join(dstDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function statType(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Resolve `relPath` under `baseDir` and assert it stays inside — defence in depth on top of the
 * caller vetting `relPath` against a main-computed diff. Returns the contained absolute path;
 * throws `PERMISSION_DENIED` on any escape. Does NOT require the path to exist.
 */
function resolveContainedRel(baseDir: string, relPath: string): string {
  const base = path.resolve(baseDir);
  const abs = path.resolve(base, relPath);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throwIpcError('PERMISSION_DENIED', 'path escapes the skill directory');
  }
  return abs;
}

export function createNodeSkillsFs(): SkillsFs {
  return {
    listSkillNames(baseDir: string): string[] {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
      } catch {
        return [];
      }
      const names: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const marker = statType(path.join(baseDir, entry.name, SKILL_MARKER));
        if (marker && marker.isFile()) names.push(entry.name);
      }
      names.sort();
      return names;
    },

    readMeta(skillDir: string): SkillMeta | null {
      try {
        const text = fs.readFileSync(path.join(skillDir, SKILL_MARKER), 'utf8');
        return parseSkillFrontmatter(text);
      } catch {
        return null;
      }
    },

    measure(skillDir: string): { fileCount: number; totalBytes: number; modifiedAt: number } {
      let totalBytes = 0;
      let modifiedAt = 0;
      const rels = collectFiles(skillDir);
      for (const rel of rels) {
        const st = fs.statSync(path.join(skillDir, rel));
        totalBytes += st.size;
        if (st.mtimeMs > modifiedAt) modifiedAt = st.mtimeMs;
      }
      return { fileCount: rels.length, totalBytes, modifiedAt: Math.floor(modifiedAt) };
    },

    isSkillDir(skillDir: string): boolean {
      const st = statType(skillDir);
      return st !== null && st.isDirectory();
    },

    hasMarker(skillDir: string): boolean {
      const st = statType(path.join(skillDir, SKILL_MARKER));
      return st !== null && st.isFile();
    },

    compare(centralDir: string, agentDir: string): SkillFileDiff[] {
      return compareDirs(centralDir, agentDir);
    },

    differs(centralDir: string, agentDir: string): boolean {
      return compareDirs(centralDir, agentDir).length > 0;
    },

    readTextFile(skillDir: string, relPath: string, maxBytes: number): SkillFileContent {
      const abs = resolveContainedRel(skillDir, relPath);
      // Reject a symlink at any component along the path (base excluded).
      let cur = path.resolve(skillDir);
      const rel = path.relative(cur, abs);
      for (const seg of rel.split(path.sep)) {
        if (seg === '') continue;
        cur = path.join(cur, seg);
        const link = statType(cur);
        if (link && link.isSymbolicLink()) {
          throwIpcError('PERMISSION_DENIED', `symbolic link in path: ${seg}`);
        }
      }
      const st = statType(abs);
      if (st === null || !st.isFile()) return { text: null, binary: false, truncated: false };

      const fd = fs.openSync(abs, 'r');
      try {
        const buf = Buffer.alloc(maxBytes + 1);
        const read = fs.readSync(fd, buf, 0, maxBytes + 1, 0);
        const slice = buf.subarray(0, read);
        if (looksBinary(slice)) return { text: null, binary: true, truncated: false };
        const truncated = read > maxBytes;
        const text = slice.subarray(0, Math.min(read, maxBytes)).toString('utf8');
        return { text, binary: false, truncated };
      } finally {
        fs.closeSync(fd);
      }
    },

    replaceDir(srcDir: string, dstDir: string): void {
      // Validate + measure the source FIRST — refuses symlinks and caps before touching dst.
      const rels = collectFiles(srcDir);
      const parent = path.dirname(dstDir);
      const base = path.basename(dstDir);
      const tmp = path.join(parent, `.${base}.aiopt-tmp`);
      const old = path.join(parent, `.${base}.aiopt-old`);

      fs.mkdirSync(parent, { recursive: true });
      rmrf(tmp);
      rmrf(old);

      try {
        copyFiles(srcDir, tmp, rels);
        const dstExists = statType(dstDir) !== null;
        if (dstExists) fs.renameSync(dstDir, old);
        try {
          fs.renameSync(tmp, dstDir);
        } catch (err) {
          // Roll back: restore the previous dst if we moved it aside.
          if (dstExists && statType(dstDir) === null) {
            try {
              fs.renameSync(old, dstDir);
            } catch {
              /* best effort */
            }
          }
          throw err;
        }
        rmrf(old);
      } catch (err) {
        rmrf(tmp);
        throw err;
      }
    },

    mergeInto(centralDir: string, agentDir: string, agentPicks: string[]): void {
      // Validate + measure BOTH sides first (refuses symlinks and caps before any write).
      const centralRels = collectFiles(centralDir);
      const agentRels = new Set(collectFiles(agentDir));
      const parent = path.dirname(centralDir);
      const base = path.basename(centralDir);
      const tmp = path.join(parent, `.${base}.aiopt-tmp`);
      const old = path.join(parent, `.${base}.aiopt-old`);

      fs.mkdirSync(parent, { recursive: true });
      rmrf(tmp);
      rmrf(old);

      try {
        // Start the merged tree from central's current content …
        copyFiles(centralDir, tmp, centralRels);
        // … then apply each agent-picked file (contained: escapes are refused before touching disk).
        for (const rel of agentPicks) {
          const to = resolveContainedRel(tmp, rel);
          if (agentRels.has(rel)) {
            const from = resolveContainedRel(agentDir, rel);
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.copyFileSync(from, to);
          } else {
            // Agent lacks it → the user chose to drop this central-only file from the merge.
            rmrf(to);
          }
        }
        const dstExists = statType(centralDir) !== null;
        if (dstExists) fs.renameSync(centralDir, old);
        try {
          fs.renameSync(tmp, centralDir);
        } catch (err) {
          if (dstExists && statType(centralDir) === null) {
            try {
              fs.renameSync(old, centralDir);
            } catch {
              /* best effort */
            }
          }
          throw err;
        }
        rmrf(old);
      } catch (err) {
        rmrf(tmp);
        throw err;
      }
    },

    removeDir(dstDir: string): void {
      rmrf(dstDir);
    },
  };
}

/** `rm -rf` that tolerates absence. */
function rmrf(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

/**
 * Per-file diff of `agentDir` against `centralDir`, with CENTRAL as the source of truth:
 *   - `added`    present in central, missing from the agent
 *   - `deleted`  present in the agent, missing from central
 *   - `modified` present in both but byte-different
 * `binary` marks files whose central (or, for deletions, agent) copy contains a NUL byte.
 */
function compareDirs(centralDir: string, agentDir: string): SkillFileDiff[] {
  const central = listRelFiles(centralDir);
  const agent = listRelFiles(agentDir);
  const all = new Set<string>([...central, ...agent]);
  const diffs: SkillFileDiff[] = [];

  for (const rel of [...all].sort()) {
    const inC = central.has(rel);
    const inA = agent.has(rel);
    if (inC && !inA) {
      diffs.push({ relPath: rel, status: 'added', binary: isBinaryFile(path.join(centralDir, rel)) });
    } else if (!inC && inA) {
      diffs.push({ relPath: rel, status: 'deleted', binary: isBinaryFile(path.join(agentDir, rel)) });
    } else {
      const cBuf = readFileOrNull(path.join(centralDir, rel));
      const aBuf = readFileOrNull(path.join(agentDir, rel));
      if (cBuf === null || aBuf === null || !cBuf.equals(aBuf)) {
        diffs.push({
          relPath: rel,
          status: 'modified',
          binary: (cBuf !== null && looksBinary(cBuf)) || (aBuf !== null && looksBinary(aBuf)),
        });
      }
    }
  }
  return diffs;
}

/** Relative file paths under `root` (following no symlinks: they are simply skipped). `Set` empty if absent. */
function listRelFiles(root: string): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else if (entry.isFile()) out.add(childRel);
    }
  };
  walk(root, '');
  return out;
}

function readFileOrNull(p: string): Buffer | null {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function isBinaryFile(p: string): boolean {
  const buf = readFileOrNull(p);
  return buf !== null && looksBinary(buf);
}
