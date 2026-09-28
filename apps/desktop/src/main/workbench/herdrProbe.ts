// Resolve and probe the herdr CLI — system PATH first, then an AiOpt-managed install.
//
// Users who already installed herdr keep using that copy; the managed binary is only a fallback
// after one-click install when nothing was found on PATH. Remote tasks use
// `ssh <target> herdr …` (not herdr's `--remote` TUI attach flag, which does not apply to
// socket API subcommands).

import path from 'node:path';
import type { HerdrInstallSource } from '../../shared/workbench';
import { candidateBinDirs, findBinary, type ExecResult } from './herdrCli';

export interface HerdrProbeResult {
  installed: boolean;
  binary: string | null;
  source: HerdrInstallSource;
  version: string | null;
}

export function managedHerdrBinary(workbenchDataDir: string): string {
  return path.join(workbenchDataDir, 'herdr-bin', 'herdr');
}

export function resolveLocalHerdrBinary(opts: {
  workbenchDataDir: string;
  pathEnv: string | undefined;
  homeDir: string;
  isExecutable: (file: string) => boolean;
}): { binary: string | null; source: HerdrInstallSource } {
  const dirs = candidateBinDirs(opts.pathEnv, opts.homeDir);
  const onPath = findBinary('herdr', dirs, opts.isExecutable);
  if (onPath) return { binary: onPath, source: 'path' };
  const managed = managedHerdrBinary(opts.workbenchDataDir);
  if (opts.isExecutable(managed)) return { binary: managed, source: 'managed' };
  return { binary: null, source: null };
}

export async function probeHerdrVersion(
  exec: (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>,
  binary: string,
  sshTarget: string | null,
): Promise<string | null> {
  try {
    const out = sshTarget
      ? await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', sshTarget, 'herdr', '--version'], 15_000)
      : await exec(binary, ['--version'], 5000);
    const line = (out.stdout || out.stderr).trim().split('\n')[0] ?? '';
    const m = line.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
    return m ? m[1]! : line.slice(0, 40) || null;
  } catch {
    return null;
  }
}

export function herdrExecForTarget(
  base: (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>,
  sshTarget: string | null | undefined,
): (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult> {
  if (!sshTarget) return base;
  return (_file, args, timeoutMs) =>
    base('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', sshTarget, 'herdr', ...args], timeoutMs);
}

export function herdrSpawnArgv(
  sshTarget: string | null | undefined,
  localBinary: string,
  args: readonly string[],
): { file: string; argv: readonly string[] } {
  if (!sshTarget) return { file: localBinary, argv: args };
  return { file: 'ssh', argv: [sshTarget, 'herdr', ...args] };
}
