#!/usr/bin/env node
// Release version stamp: write the tag's version into every manifest before packaging.
//
// The tag is the single source of the release version. Electron reads the version from the
// packaged apps/desktop/package.json (installer filenames, `app.getVersion()` on the About
// page and in the update check), never from the tag, so release.yml runs this before the
// build. The manifests in the repository are not bumped per release and may lag the latest
// tag; a local build reports whatever they say.
//
// Only each manifest's `"version": "…"` line is rewritten, so the rest of the file keeps its
// formatting. Run `pnpm check:version` afterwards: it confirms the manifests now match the tag.
//
// Usage:
//   node scripts/stamp-version.mjs --tag v1.2.3
// In CI, a tag is taken from GITHUB_REF automatically when the ref is a tag.

import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);

// Keep in step with MANIFESTS in check-version.mjs.
const MANIFESTS = ['package.json', 'apps/desktop/package.json'];

/** Semver as this project tags it: three numbers, optional prerelease/build. No leading `v`. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The top-level version line. Two-space indent keeps nested `version` keys out of reach. */
const VERSION_LINE = /^( {2}"version": )"[^"]*"(,?)$/gm;

function tagFromArgs(argv) {
  const flagIndex = argv.indexOf('--tag');
  if (flagIndex !== -1) return argv[flagIndex + 1];
  const ref = process.env.GITHUB_REF ?? '';
  return ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : undefined;
}

function fail(message) {
  console.error(`Version stamp FAILED: ${message}`);
  process.exit(1);
}

function main() {
  const tag = tagFromArgs(process.argv.slice(2));
  if (!tag) fail('no tag: pass --tag v<version>, or run on a tag ref');
  if (!tag.startsWith('v')) fail(`tag ${tag} does not start with "v"`);
  const version = tag.slice(1);
  if (!SEMVER.test(version)) fail(`tag ${tag} is not v<semver>`);

  for (const relPath of MANIFESTS) {
    const url = new URL(relPath, ROOT);
    const text = readFileSync(url, 'utf8');
    const matches = text.match(VERSION_LINE) ?? [];
    if (matches.length !== 1) {
      fail(`${relPath}: expected one top-level "version" line, found ${matches.length}`);
    }
    const before = JSON.parse(text).version;
    const stamped = text.replace(VERSION_LINE, `$1${JSON.stringify(version)}$2`);
    if (JSON.parse(stamped).version !== version) fail(`${relPath}: rewrite did not take`);
    writeFileSync(url, stamped);
    console.log(`${relPath}: ${before} → ${version}`);
  }
}

main();
