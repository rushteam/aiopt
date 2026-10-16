// WorkBuddy session reader — the account WorkBuddy desktop (Tencent's CodeBuddy desktop
// agent) is signed in to. The file and its refresh live in ../upstreams/workbuddy/auth.ts;
// the provider is served by the WorkBuddy upstream driver (its headers and body rules).
//
// Read-only: AiOpt never writes WorkBuddy's file, and the token never crosses IPC.

import fs from 'node:fs';
import { readWorkBuddyDesktop, workbuddyDataRoot } from '../upstreams/workbuddy/auth';

export interface WorkBuddySessionSnapshot {
  available: boolean;
  accountLabel: string | null;
}

export function workbuddyInstallDirExists(): boolean {
  try {
    return fs.existsSync(workbuddyDataRoot());
  } catch {
    return false;
  }
}

export function workbuddySessionSnapshot(): WorkBuddySessionSnapshot {
  const a = readWorkBuddyDesktop();
  if (!a) return { available: false, accountLabel: null };
  return { available: true, accountLabel: a.name || 'WorkBuddy' };
}

export function readWorkBuddyAccessTokenSync(): string | null {
  return readWorkBuddyDesktop()?.access ?? null;
}
