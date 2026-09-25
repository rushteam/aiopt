#!/usr/bin/env node
// Fuses gate: the packaged app under out/ must carry the hardening fuses that
// docs/dev-rules/electron-security-and-process-boundaries.md §7 requires.
//
// This exists because v1.0.0 shipped without them. forge.config.ts loaded FusesPlugin only
// when process.argv contained `package` or `make`, but Forge runs each command as its own
// script (electron-forge-make.js), so that test was always false: the plugin never ran and
// the build still succeeded. Read the flipped binary back instead of trusting the config.
//
// Usage, after `pnpm --filter desktop run package` or `build`:
//   pnpm --filter desktop run check:fuses

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');

// Keep in step with the FusesPlugin block in forge.config.ts.
const EXPECTED = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
};

/** The app to read in one `out/AiOpt-<platform>-<arch>` directory. */
function appPath(dir) {
  const platform = path.basename(dir).split('-')[1];
  if (platform === 'darwin' || platform === 'mas') return path.join(dir, 'AiOpt.app');
  if (platform === 'win32') return path.join(dir, 'AiOpt.exe');
  return path.join(dir, 'AiOpt');
}

async function main() {
  let dirs;
  try {
    dirs = readdirSync(OUT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('AiOpt-'))
      .map((d) => path.join(OUT, d.name));
  } catch {
    dirs = [];
  }
  if (dirs.length === 0) {
    console.error('Fuses check FAILED: no packaged app under apps/desktop/out — package first.');
    process.exit(1);
  }

  const errors = [];
  for (const dir of dirs) {
    const wire = await getCurrentFuseWire(appPath(dir));
    for (const [option, want] of Object.entries(EXPECTED)) {
      // The wire stores ASCII '1' (enabled) / '0' (disabled) per fuse.
      const got = String.fromCharCode(wire[option]) === '1';
      if (got !== want) {
        errors.push(`${path.basename(dir)}: ${FuseV1Options[option]} is ${got}, expected ${want}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error('Fuses check FAILED:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`✅ fuses — ${dirs.map((d) => path.basename(d)).join(', ')} hardened.`);
}

await main();
