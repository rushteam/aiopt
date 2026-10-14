import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentSessionStore } from '../agentSessionStore';
import { createInMemoryRegistry, type IpcInvokeMeta } from '../../ipc/registry';
import { throwIpcError } from '../../ipc/validate';
import { registerSessionsIpc } from '../sessionsIpc';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';

const SID = '6f1c2a90-1d2e-4c55-9a51-0f7d3e2b8a11';
const SUB = 'a1b2c3d4-0000-4000-8000-000000000001';
const CID = '0198a3c4-77e2-7b10-9c3d-5e6f7a8b9c0d';
const TS = new Date().toISOString();
const NOW = Date.parse(TS) + 1000;

const trusted: IpcInvokeMeta = { assertTrustedSender: () => {} };
const untrusted: IpcInvokeMeta = { assertTrustedSender: () => throwIpcError('PERMISSION_DENIED', 'nope') };

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// Windows without Developer Mode cannot create symlinks; skip that one fixture there
// rather than erroring (same probe as skillsFs.test.ts).
const CAN_SYMLINK = ((): boolean => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(probe, 'f'), '');
    fs.symlinkSync(path.join(probe, 'f'), path.join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();
const itWithSymlink = CAN_SYMLINK ? it : it.skip;

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-sessions-'));
  const project = path.join(home, '.claude', 'projects', '-w-app');
  write(
    path.join(project, `${SID}.jsonl`),
    jsonl([
      { type: 'user', sessionId: SID, cwd: '/w/app', timestamp: TS, message: { content: 'Add retry' } },
      { type: 'assistant', sessionId: SID, timestamp: TS, message: { id: 'm1', model: 'opus', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 4 } } },
    ]) + '{"torn": ',
  );
  write(
    path.join(project, SID, 'subagents', 'agent-1.jsonl'),
    jsonl([
      { type: 'user', sessionId: SUB, timestamp: TS, isSidechain: true, message: { content: 'sub task' } },
      { type: 'assistant', sessionId: SUB, timestamp: TS, isSidechain: true, message: { id: 's1', model: 'haiku', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 10, output_tokens: 10 } } },
    ]),
  );
  write(
    path.join(home, '.codex', 'sessions', '2025', '06', '30', `rollout-2025-06-30T10-00-00-${CID}.jsonl`),
    jsonl([
      { timestamp: TS, type: 'session_meta', payload: { id: CID, cwd: "/w/it's" } },
      { timestamp: TS, type: 'turn_context', payload: { model: 'gpt-5' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'Why?' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 9 }, last_token_usage: { input_tokens: 5, output_tokens: 4 } } } },
    ]),
  );
  // A file outside the fixed layout is never read.
  write(path.join(home, '.codex', 'sessions', 'stray.jsonl'), jsonl([{ type: 'session_meta', payload: { id: 'ffffffff-stray' } }]));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agent session store', () => {
  it('lists sessions from both agents, skipping subagent files', async () => {
    const store = createAgentSessionStore({ home: () => home, now: () => NOW });
    const snap = await store.sessions();
    expect(snap.sessions.map((s) => `${s.agentId}:${s.sessionId}`).sort()).toEqual([`claude:${SID}`, `codex:${CID}`]);
    expect(snap.truncated).toBe(false);
  });

  it('local usage includes subagent traffic', async () => {
    const store = createAgentSessionStore({ home: () => home, now: () => NOW });
    const usage = await store.localUsage();
    expect(usage.totals.responses).toBe(3);
    expect(usage.totals.totalTokens).toBe(3 + 4 + 10 + 10 + 5 + 4);
    expect(usage.sessionCount).toBe(3);
    expect(usage.byAgent.map((b) => b.key)).toEqual(['claude', 'codex']);
  });

  it('returns a transcript by (agentId, sessionId) and 404s on unknown ids', async () => {
    const store = createAgentSessionStore({ home: () => home, now: () => NOW });
    const t = await store.transcript({ agentId: 'claude', sessionId: SID });
    expect(t.entries.map((e) => e.text)).toEqual(['Add retry', 'ok']);
    await expect(store.transcript({ agentId: 'codex', sessionId: SID })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('picks up a new session on refresh, after the minimum interval', async () => {
    let now = NOW;
    const store = createAgentSessionStore({ home: () => home, now: () => now });
    expect((await store.sessions()).sessions).toHaveLength(2);
    const other = 'b2c3d4e5-0000-4000-8000-000000000002';
    write(
      path.join(home, '.claude', 'projects', '-w-b', `${other}.jsonl`),
      jsonl([{ type: 'user', sessionId: other, timestamp: TS, message: { content: 'hello' } }]),
    );
    expect((await store.sessions({ refresh: true })).sessions).toHaveLength(2); // throttled
    now += 10_000;
    expect((await store.sessions({ refresh: true })).sessions).toHaveLength(3);
  });

  itWithSymlink('does not follow symlinked session files', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-sessions-out-'));
    try {
      const target = path.join(outside, 'secret.jsonl');
      const other = 'c3d4e5f6-0000-4000-8000-000000000003';
      write(target, jsonl([{ type: 'user', sessionId: other, timestamp: TS, message: { content: 'secret' } }]));
      fs.symlinkSync(target, path.join(home, '.claude', 'projects', '-w-app', `${other}.jsonl`));
      const store = createAgentSessionStore({ home: () => home, now: () => NOW });
      const ids = (await store.sessions()).sessions.map((s) => s.sessionId);
      expect(ids).not.toContain(other);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('handles a missing agent home', async () => {
    const store = createAgentSessionStore({ home: () => path.join(home, 'nope'), now: () => NOW });
    expect((await store.sessions()).sessions).toEqual([]);
    expect((await store.localUsage()).totals.responses).toBe(0);
  });
});

describe('sessions IPC', () => {
  function setup(pick: string | null = '/tmp/out.md') {
    const reg = createInMemoryRegistry();
    const store = createAgentSessionStore({ home: () => home, now: () => NOW });
    const deps = {
      writeClipboard: vi.fn(),
      pickSavePath: vi.fn(async () => pick),
      writeFile: vi.fn(async () => {}),
      platform: 'darwin',
    };
    registerSessionsIpc(reg, store, deps);
    return { reg, deps };
  }

  it('authorizes the sender before anything else', async () => {
    const { reg, deps } = setup();
    for (const ch of [
      IPC_CHANNELS.sessionsList,
      IPC_CHANNELS.sessionsLocalUsage,
      IPC_CHANNELS.sessionsTranscript,
      IPC_CHANNELS.sessionsCopyResume,
      IPC_CHANNELS.sessionsExport,
    ]) {
      await expect(reg.invoke(ch, { agentId: 'claude', sessionId: SID }, untrusted)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    expect(deps.writeClipboard).not.toHaveBeenCalled();
    expect(deps.pickSavePath).not.toHaveBeenCalled();
  });

  it('validates refs and refresh', async () => {
    const { reg } = setup();
    for (const bad of [
      undefined,
      { agentId: 'gemini', sessionId: SID },
      { agentId: 'claude', sessionId: '../../../etc/passwd' },
      { agentId: 'claude', sessionId: 42 },
    ]) {
      await expect(reg.invoke(IPC_CHANNELS.sessionsTranscript, bad, trusted)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    await expect(reg.invoke(IPC_CHANNELS.sessionsList, { refresh: 'yes' }, trusted)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(reg.invoke(IPC_CHANNELS.sessionsList, undefined, trusted)).resolves.toBeTruthy();
  });

  it('copies the resume command main-side', async () => {
    const { reg, deps } = setup();
    await reg.invoke(IPC_CHANNELS.sessionsCopyResume, { agentId: 'codex', sessionId: CID }, trusted);
    expect(deps.writeClipboard).toHaveBeenCalledWith(`cd '/w/it'\\''s' && codex resume ${CID}`);
  });

  it('exports Markdown to the path picked in main; cancel writes nothing', async () => {
    const { reg, deps } = setup();
    await expect(reg.invoke(IPC_CHANNELS.sessionsExport, { agentId: 'claude', sessionId: SID }, trusted)).resolves.toEqual({ saved: true });
    expect(deps.pickSavePath).toHaveBeenCalledWith(`claude-${SID}.md`);
    expect(deps.writeFile).toHaveBeenCalledWith('/tmp/out.md', expect.stringContaining('# Add retry'));

    const cancelled = setup(null);
    await expect(
      cancelled.reg.invoke(IPC_CHANNELS.sessionsExport, { agentId: 'claude', sessionId: SID }, trusted),
    ).resolves.toEqual({ saved: false });
    expect(cancelled.deps.writeFile).not.toHaveBeenCalled();
  });
});
