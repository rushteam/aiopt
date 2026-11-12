import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GIT_SAFE_CONFIG,
  isCommitId,
  parseNameStatusZ,
  parseNumstatZ,
  readHeadCommit,
  readTaskChanges,
  splitPatch,
  type GitExecResult,
} from '../taskChanges';

describe('task changes parsing', () => {
  it('parses numstat -z including renames and binaries', () => {
    expect(parseNumstatZ('3\t1\ta.ts\0-\t-\timg.png\0' + '2\t0\t\0old name.ts\0new name.ts\0')).toEqual([
      { path: 'a.ts', oldPath: null, additions: 3, deletions: 1 },
      { path: 'img.png', oldPath: null, additions: null, deletions: null },
      { path: 'new name.ts', oldPath: 'old name.ts', additions: 2, deletions: 0 },
    ]);
  });

  it('parses name-status -z', () => {
    const map = parseNameStatusZ('M\0a.ts\0A\0b.ts\0D\0c.ts\0R087\0old.ts\0new.ts\0');
    expect([...map]).toEqual([
      ['a.ts', 'modified'],
      ['b.ts', 'added'],
      ['c.ts', 'deleted'],
      ['new.ts', 'renamed'],
    ]);
  });

  it('splits only at line-start diff headers', () => {
    const text = 'diff --git a/x b/x\n+say diff --git inline\ndiff --git a/y b/y\n-1\n';
    expect(splitPatch(text)).toEqual(['diff --git a/x b/x\n+say diff --git inline\n', 'diff --git a/y b/y\n-1\n']);
    expect(splitPatch('')).toEqual([]);
  });

  it('accepts only full commit ids', () => {
    expect(isCommitId('a'.repeat(40))).toBe(true);
    expect(isCommitId('HEAD')).toBe(false);
    expect(isCommitId('--output=/tmp/x')).toBe(false);
    expect(isCommitId('a'.repeat(39))).toBe(false);
  });
});

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The few host variables git needs to start. Windows git fails without SystemRoot /
 * USERPROFILE / TEMP; everything else (the user's git config included) stays out.
 */
function hostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'SystemRoot', 'windir', 'USERPROFILE', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

// An empty file, not os.devNull: Windows git rejects \\.\nul as a config path.
let emptyGlobalConfig = '';
let globalConfigDir = '';
beforeAll(() => {
  globalConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-taskchanges-cfg-'));
  emptyGlobalConfig = path.join(globalConfigDir, 'gitconfig');
  fs.writeFileSync(emptyGlobalConfig, '');
});
afterAll(() => {
  fs.rmSync(globalConfigDir, { recursive: true, force: true });
});

/** A GitExec that also keeps stderr, so a failed setup step says why. */
const realExec: (args: readonly string[]) => Promise<GitExecResult & { stderr: string }> = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        encoding: 'utf8',
        env: {
          ...hostEnv(),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: emptyGlobalConfig,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.com',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.com',
        },
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 0;
        if (err && typeof (err as { code?: unknown }).code !== 'number') reject(err);
        else resolve({ code, stdout, stderr });
      },
    );
  });

describe.skipIf(!gitAvailable())('readTaskChanges (real git)', () => {
  let dir = '';
  const run = async (...args: string[]) => {
    const out = await realExec(['-C', dir, ...args]);
    if (out.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr ?? ''}`);
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-taskchanges-'));
    await run('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye\n');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b\n');
    await run('add', '.');
    await run('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('diffs against the launch commit: commits since, uncommitted edits and untracked files', async () => {
    const base = await readHeadCommit(realExec, dir);
    expect(base && isCommitId(base)).toBe(true);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n2\nthree\n');
    await run('commit', '-q', '-am', 'worker commit');
    fs.rmSync(path.join(dir, 'gone.txt'));
    fs.writeFileSync(path.join(dir, 'new file.txt'), 'x\ny\n');

    const out = await readTaskChanges(realExec, dir, base);
    expect(out.since).toBe('launch');
    expect(out.truncated).toBe(false);
    const byPath = new Map(out.files.map((f) => [f.path, f]));
    expect(byPath.get('a.txt')).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
    expect(byPath.get('a.txt')?.patch).toContain('+three');
    expect(byPath.get('gone.txt')).toMatchObject({ status: 'deleted', deletions: 1 });
    expect(byPath.get('new file.txt')).toMatchObject({ status: 'untracked', additions: 2, deletions: 0 });
    expect(byPath.get('new file.txt')?.patch).toContain('+y');
  });

  it('falls back to HEAD for an unknown base and limits a subfolder to itself', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b2\n');
    const sub = path.join(dir, 'sub');
    const out = await readTaskChanges(realExec, sub, 'f'.repeat(40));
    expect(out.since).toBe('head');
    expect(out.files.map((f) => f.path)).toEqual(['b.txt']);
  });

  it('never runs an external diff driver configured in the repo', async () => {
    const marker = path.join(dir, 'ran');
    await run('config', 'diff.external', `sh -c 'touch ${marker}'`);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    const out = await readTaskChanges(realExec, dir, null);
    expect(out.files[0]?.patch).toContain('+changed');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('puts the hardening config before the subcommand', () => {
    expect(GIT_SAFE_CONFIG).toContain('core.fsmonitor=false');
  });
});
