// Kiro session reader — the account kiro-cli or the Kiro IDE is signed in to. Where each
// keeps it, and its renewal, live in ../upstreams/kiro/auth.ts; the provider is served by
// the Kiro upstream driver (Kiro's own conversation API).
//
// Read-only: AiOpt never writes kiro-cli's database or the IDE's file, and the token never
// crosses IPC.

import fs from 'node:fs';
import path from 'node:path';
import { kiroCliDb, kiroExecutable, kiroIdeTokenFile, readKiro } from '../upstreams/kiro/auth';

export interface KiroSessionSnapshot {
  available: boolean;
  accountLabel: string | null;
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function kiroInstallDirExists(): boolean {
  return exists(path.dirname(kiroCliDb())) || exists(kiroIdeTokenFile()) || kiroExecutable() !== '';
}

export function kiroSessionSnapshot(): KiroSessionSnapshot {
  const c = readKiro();
  if (!c) return { available: false, accountLabel: null };
  return { available: true, accountLabel: c.source === 'kiro-cli' ? 'kiro-cli' : 'Kiro IDE' };
}

export function readKiroAccessTokenSync(): string | null {
  return readKiro()?.access ?? null;
}
