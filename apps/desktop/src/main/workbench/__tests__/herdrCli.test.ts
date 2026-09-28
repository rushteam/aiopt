import { describe, expect, it, vi } from 'vitest';
import {
  candidateBinDirs,
  createHerdrClient,
  findBinary,
  HerdrError,
  parseHerdrOutput,
  promptText,
  type ExecResult,
} from '../herdrCli';

const ok = (result: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify({ id: 'cli:x', result }), stderr: '' });
const fail = (code: string): ExecResult => ({
  code: 1,
  stdout: JSON.stringify({ error: { code, message: `${code} happened` }, id: 'cli:x' }),
  stderr: '',
});

const PANE = {
  root_pane: { pane_id: 'w2:p1', tab_id: 'w2:t1', workspace_id: 'w2' },
  tab: { tab_id: 'w2:t1' },
  workspace: { workspace_id: 'w2', worktree: { repo_key: '/r/.git' } },
};

function client(outputs: ExecResult[]) {
  const exec = vi.fn(async (_file: string, _args: readonly string[], _timeoutMs: number) => outputs.shift() ?? ok({}));
  const sleep = vi.fn(async () => {});
  return { exec, sleep, herdr: createHerdrClient({ binary: '/bin/herdr', session: 'aiopt', exec, sleep }) };
}

describe('parseHerdrOutput', () => {
  it('returns the result object on success', () => {
    expect(parseHerdrOutput(ok({ type: 'ok' }))).toEqual({ type: 'ok' });
  });

  it('throws herdr error codes, usage errors, and unreadable output', () => {
    expect(() => parseHerdrOutput(fail('agent_not_found'))).toThrow(
      expect.objectContaining({ code: 'agent_not_found' }),
    );
    expect(() => parseHerdrOutput({ code: 2, stdout: '', stderr: 'unknown option: --json\n' })).toThrow(
      expect.objectContaining({ code: 'usage', message: 'unknown option: --json' }),
    );
    expect(() => parseHerdrOutput({ code: 0, stdout: 'hello', stderr: '' })).toThrow(
      expect.objectContaining({ code: 'parse' }),
    );
    expect(() => parseHerdrOutput({ code: 1, stdout: '', stderr: 'server is not running\n' })).toThrow(
      expect.objectContaining({ code: 'exec' }),
    );
  });
});

describe('promptText', () => {
  it('defuses pi editor prefixes and herdr option parsing', () => {
    expect(promptText('!rm -rf ~')).toBe('Message: !rm -rf ~');
    expect(promptText('/login')).toBe('Message: /login');
    expect(promptText('--help')).toBe('Message: --help');
    expect(promptText('  fix the bug')).toBe('fix the bug');
  });

  it('strips control characters (an ESC typed into a terminal is a command)', () => {
    expect(promptText('a\u001b[2Jb\r\nc')).toBe('a[2Jb\nc');
  });
});

describe('herdr client', () => {
  it('always targets its own session and never passes --json to pane commands', async () => {
    const { exec, herdr } = client([ok(PANE), { code: 0, stdout: 'line\n', stderr: '' }]);
    await herdr.workspaceCreate('/tmp/app', 'Fix bug');
    await herdr.agentRead('wb-abc', 40);
    for (const call of exec.mock.calls) {
      const args = call[1] as string[];
      expect(args.slice(0, 2)).toEqual(['--session', 'aiopt']);
      expect(args).not.toContain('--json');
    }
    expect(exec.mock.calls[0]![1]).toEqual([
      '--session', 'aiopt', 'workspace', 'create', '--cwd', '/tmp/app', '--label', 'Fix bug', '--no-focus',
    ]);
  });

  it('parses workspace and worktree refs', async () => {
    const { herdr } = client([ok(PANE), ok({ ...PANE, worktree: { path: '/h/wt/wb-x' } })]);
    expect(await herdr.workspaceCreate('/tmp/app', 'x')).toEqual({ workspaceId: 'w2', tabId: 'w2:t1', paneId: 'w2:p1' });
    expect(await herdr.worktreeCreate('/tmp/app', 'wb/x-abc123')).toEqual({
      workspaceId: 'w2',
      tabId: 'w2:t1',
      paneId: 'w2:p1',
      path: '/h/wt/wb-x',
      repoKey: '/r/.git',
    });
  });

  it('accepts the plain-text success line of integration install, and surfaces its failure', async () => {
    const good = client([{ code: 0, stdout: 'installed pi integration to /x/extensions/herdr-agent-state.ts\n', stderr: '' }]);
    await expect(good.herdr.installPiIntegration()).resolves.toBeUndefined();
    expect(good.exec.mock.calls[0]![1]).toEqual(['--session', 'aiopt', 'integration', 'install', 'pi']);
    const bad = client([{ code: 1, stdout: '', stderr: 'permission denied' }]);
    await expect(bad.herdr.installPiIntegration()).rejects.toBeInstanceOf(HerdrError);
  });

  it('rejects malformed ids, names, branches, and relative paths before exec', async () => {
    const { exec, herdr } = client([]);
    await expect(herdr.workspaceClose('w1; rm')).rejects.toBeInstanceOf(HerdrError);
    await expect(herdr.agentPrompt('Bad Name', 'hi')).rejects.toBeInstanceOf(HerdrError);
    await expect(herdr.worktreeCreate('/r', 'main')).rejects.toBeInstanceOf(HerdrError);
    await expect(herdr.workspaceCreate('--cwd', 'x')).rejects.toBeInstanceOf(HerdrError);
    await expect(herdr.agentStart('wb-a', 'p1', [])).rejects.toBeInstanceOf(HerdrError);
    await expect(herdr.agentPrompt('wb-a', '   ')).rejects.toBeInstanceOf(HerdrError);
    expect(exec).not.toHaveBeenCalled();
  });

  it('retries agent start while the pane is busy', async () => {
    const { exec, sleep, herdr } = client([fail('agent_pane_busy'), fail('agent_pane_busy'), ok({})]);
    await herdr.agentStart('wb-a', 'w2:p1', ['--offline']);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0]![1]).toEqual([
      '--session', 'aiopt', 'agent', 'start', 'wb-a', '--kind', 'pi', '--pane', 'w2:p1', '--', '--offline',
    ]);
  });

  it('does not retry other start failures', async () => {
    const { exec, herdr } = client([fail('agent_start_timeout')]);
    await expect(herdr.agentStart('wb-a', 'w2:p1', [])).rejects.toMatchObject({ code: 'agent_start_timeout' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('lists agents and workspaces defensively', async () => {
    const { herdr } = client([
      ok({ agents: [{ name: 'wb-a', agent_status: 'working', workspace_id: 'w2' }, { agent_status: 'idle' }, 'junk'] }),
      ok({
        workspaces: [
          { workspace_id: 'w1', worktree: { repo_key: '/r/.git', is_linked_worktree: false } },
          { workspace_id: 'w2' },
          { workspace_id: 'nope' },
        ],
      }),
    ]);
    expect(await herdr.agentList()).toEqual([{ name: 'wb-a', status: 'working', workspaceId: 'w2' }]);
    expect(await herdr.workspaceList()).toEqual([
      { workspaceId: 'w1', repoKey: '/r/.git', isLinkedWorktree: false },
      { workspaceId: 'w2', repoKey: null, isLinkedWorktree: false },
    ]);
  });

  it('reports the server as not running on any failure', async () => {
    const { herdr } = client([{ code: 0, stdout: '{"status":"not_running","running":false}', stderr: '' }]);
    expect(await herdr.isRunning()).toBe(false);
    const { herdr: up } = client([{ code: 0, stdout: '{"running":true}', stderr: '' }]);
    expect(await up.isRunning()).toBe(true);
    const { herdr: broken } = client([{ code: 0, stdout: 'garbage', stderr: '' }]);
    expect(await broken.isRunning()).toBe(false);
  });
});

describe('binary lookup', () => {
  it('adds the usual install dirs to a minimal Finder PATH', () => {
    const dirs = candidateBinDirs('/usr/bin:/bin', '/Users/me');
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(dirs).toContain('/Users/me/.local/bin');
    expect(dirs.filter((d) => d === '/usr/bin')).toHaveLength(1);
  });

  it('ignores relative PATH entries', () => {
    expect(candidateBinDirs('.:bin:/x', '/h')).not.toContain('.');
  });

  it('returns the first executable match', () => {
    const exists = new Set(['/b/pi', '/c/pi']);
    expect(findBinary('pi', ['/a', '/b/', '/c'], (f) => exists.has(f))).toBe('/b/pi');
    expect(findBinary('pi', ['/a'], (f) => exists.has(f))).toBeNull();
  });
});
