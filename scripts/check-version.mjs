#!/usr/bin/env node
// Version gate: the release tag, the root package.json and the desktop package.json must
// all state the same version.
//
// This exists because they didn't. The repo sat at 0.0.0 in both manifests while
// release.yml was ready to build installers from any `v*` tag — so `git push origin v0.1.0`
// would have produced a Release named v0.1.0 full of files named AiOpt-0.0.0, and an About
// page reporting 0.0.0 to the user. Electron reads the version from the packaged
// package.json (`app.getVersion()`, see main/services.ts), never from the tag; nothing in
// the build would have noticed or complained.
//
// The two manifests are checked against each other on every CI run, so they cannot drift
// while nobody is releasing. The tag is checked only when there is one.
//
// Local usage:
//   pnpm check:version              root and desktop manifests agree
//   pnpm check:version --tag v0.1.0 ...and that tag matches them
// In CI, a tag is taken from GITHUB_REF automatically when the ref is a tag.

import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);

// Every manifest whose version is user-visible. `desktop` is the one Electron packages and
// `app.getVersion()` returns; the root is what a reader checks first, so a mismatch between
// them is its own bug even before a tag exists.
const MANIFESTS = ['package.json', 'apps/desktop/package.json'];

/** Semver as this project tags it: three numbers, optional prerelease/build. No leading `v`. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readVersion(relPath) {
  return JSON.parse(readFileSync(new URL(relPath, ROOT), 'utf8')).version;
}

/**
 * The tag to check, or undefined. An explicit `--tag` wins; otherwise a tag ref from the
 * GitHub event. A branch ref yields nothing — pushes to main are not releases.
 */
function tagToCheck(argv) {
  const flagIndex = argv.indexOf('--tag');
  if (flagIndex !== -1) {
    const value = argv[flagIndex + 1];
    if (!value) {
      console.error('--tag needs a value, e.g. --tag v0.1.0');
      process.exit(2);
    }
    return value;
  }
  const ref = process.env.GITHUB_REF ?? '';
  return ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : undefined;
}

function main() {
  const errors = [];
  const versions = MANIFESTS.map((relPath) => ({ relPath, version: readVersion(relPath) }));

  for (const { relPath, version } of versions) {
    if (typeof version !== 'string' || !SEMVER.test(version)) {
      errors.push(`${relPath}: version ${JSON.stringify(version)} is not a plain semver string`);
    }
  }

  const distinct = [...new Set(versions.map((v) => v.version))];
  if (distinct.length > 1) {
    errors.push(
      `manifests disagree: ${versions.map((v) => `${v.relPath}=${v.version}`).join(', ')}`,
    );
  }

  const tag = tagToCheck(process.argv.slice(2));
  if (tag !== undefined) {
    // Tags are `v`-prefixed (release.yml triggers on `v*`); the manifests are not.
    if (!tag.startsWith('v')) {
      errors.push(`tag ${tag} does not start with "v"`);
    } else {
      const tagVersion = tag.slice(1);
      for (const { relPath, version } of versions) {
        if (version !== tagVersion) {
          errors.push(`tag ${tag} does not match ${relPath} version ${version}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error('Version check FAILED:');
    for (const error of errors) console.error(`  - ${error}`);
    console.error(
      '\nBump every manifest and tag the same version: edit package.json and' +
        ' apps/desktop/package.json, commit, then tag v<version>.',
    );
    process.exit(1);
  }

  const scope = tag !== undefined ? `tag ${tag}` : 'no tag in scope';
  console.log(`✅ version ${distinct[0]} — ${MANIFESTS.length} manifests agree, ${scope}.`);
}

main();
