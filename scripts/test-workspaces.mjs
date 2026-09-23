#!/usr/bin/env node
// Single entry point for the repo's unit tier: run each workspace's `test` script (if it has
// one) and aggregate the results, failing if any workspace fails.
//
// The primitive being preserved: `pnpm test:unit` at the root is the one command the commit
// gate runs, and it deterministically covers every workspace — a new package is included the
// moment it declares a `test` script, with nothing to wire up by hand. A mature repo grows
// this into a manifest-driven, multi-tier runner; this is the small faithful core.
//
// Usage:
//   node scripts/test-workspaces.mjs                 run every workspace's test script
//   node scripts/test-workspaces.mjs --filter <pkg>  run one workspace by package name

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Parse the (intentionally tiny subset of) pnpm-workspace.yaml we author: `- 'apps/*'`. */
function parseWorkspacePatterns(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^-\s+["']?([^"']+)["']?$/)?.[1])
    .filter(Boolean);
}

/** Expand `apps/*` style patterns into concrete workspace directories that have a package.json. */
function expandWorkspaces(patterns) {
  const dirs = [];
  for (const pattern of patterns) {
    const normalized = pattern.replace(/\\/g, '/');
    if (!normalized.endsWith('/*') || normalized.slice(0, -2).includes('*')) {
      throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }
    const base = normalized.slice(0, -2);
    const absBase = path.join(ROOT, ...base.split('/'));
    if (!fs.existsSync(absBase)) continue;
    for (const entry of fs.readdirSync(absBase, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `${base}/${entry.name}`;
      if (fs.existsSync(path.join(ROOT, rel, 'package.json'))) dirs.push(rel);
    }
  }
  return dirs.sort();
}

function readPackageJson(dir) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
}

function main() {
  const filterIndex = process.argv.indexOf('--filter');
  const filterName = filterIndex !== -1 ? process.argv[filterIndex + 1] : undefined;

  const patterns = parseWorkspacePatterns(fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8'));
  const workspaces = expandWorkspaces(patterns);

  const results = [];
  for (const dir of workspaces) {
    const pkg = readPackageJson(dir);
    if (filterName && pkg.name !== filterName) continue;
    const hasTest = Boolean(pkg.scripts?.test);
    if (!hasTest) {
      results.push({ dir, name: pkg.name, status: 'SKIP', reason: 'no test script' });
      continue;
    }
    console.log(`\n▶ ${pkg.name} (${dir})`);
    // `cwd` rather than `--dir <path>`: on Windows `pnpm` is `pnpm.cmd`, and since Node
    // 18.20.2 a `.cmd` cannot be spawned without `shell: true` (the batch-injection fix), so
    // the shell is not optional there — and under a shell every argv entry is re-parsed by
    // cmd.exe, unquoted. An absolute path in argv therefore split at the first space, which a
    // Windows checkout easily has (`C:\Users\Ada Lovelace\...`), failing the whole unit gate
    // with a confusing pnpm usage error. Nothing in argv needs quoting now.
    const run = spawnSync('pnpm', ['run', 'test'], {
      cwd: path.join(ROOT, dir),
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    results.push({ dir, name: pkg.name, status: run.status === 0 ? 'PASS' : 'FAIL' });
  }

  if (filterName && results.length === 0) {
    console.error(`No workspace matched --filter ${filterName}`);
    process.exit(1);
  }

  console.log('\nUnit test summary');
  for (const r of results) {
    console.log(`  ${r.status.padEnd(4)} ${r.name}${r.reason ? ` — ${r.reason}` : ''}`);
  }
  if (results.some((r) => r.status === 'FAIL')) process.exit(1);
}

main();
