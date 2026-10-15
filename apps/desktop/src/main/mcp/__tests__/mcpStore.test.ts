import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpStore, validateSaveRequest, type McpConfirmRequest } from '../mcpStore';
import { readAgentMcp } from '../agentMcpConfig';
import { registerMcpIpc } from '../mcpIpc';
import { buildMcpConfirm } from '../mcpConfirm';
import type { SecretStore } from '../../secrets/secretStore';
import { createInMemoryRegistry, type IpcInvokeMeta } from '../../ipc/registry';
import { throwIpcError } from '../../ipc/validate';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { isIpcError, decodeIpcError } from '../../../shared/ipc-errors';
import type { McpSaveRequest, McpSnapshot } from '../../../shared/mcp';

let home: string;
let dir: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-mcp-home-'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-mcp-data-'));
  prevHome = process.env.AIOPT_AGENT_HOME;
  process.env.AIOPT_AGENT_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.AIOPT_AGENT_HOME;
  else process.env.AIOPT_AGENT_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

function memorySecrets(available = true): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    isAvailable: () => available,
    set: (k, v) => {
      if (!available) throwIpcError('PRECONDITION_FAILED', 'OS secret encryption is unavailable');
      map.set(k, v);
    },
    get: (k) => map.get(k) ?? null,
    has: (k) => map.has(k),
    delete: (k) => void map.delete(k),
  };
}

function makeStore(opts: { confirm?: boolean; secrets?: ReturnType<typeof memorySecrets> } = {}) {
  const secrets = opts.secrets ?? memorySecrets();
  const confirmWrite = vi.fn(async (_reqs: McpConfirmRequest[]) => opts.confirm ?? true);
  const store = createMcpStore({
    filePath: path.join(dir, 'mcp-servers.json'),
    secrets,
    confirmWrite,
    isInstalled: () => true,
    displayPath: (p) => p.replace(home, '~'),
  });
  return { store, secrets, confirmWrite };
}

const claudeFile = () => path.join(home, '.claude.json');
const claudeServers = (): Record<string, Record<string, unknown>> =>
  ((JSON.parse(fs.readFileSync(claudeFile(), 'utf8')) as { mcpServers?: object }).mcpServers ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

const fsServer: McpSaveRequest = {
  name: 'fs',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server-fs'],
  env: [{ key: 'TOKEN', value: 'secret-1' }],
  headers: [],
};

function codeOf(err: unknown): string {
  if (isIpcError(err)) return err.code;
  return decodeIpcError((err as Error).message).code;
}

describe('validateSaveRequest', () => {
  const ok = (over: Partial<McpSaveRequest> & Record<string, unknown>) => validateSaveRequest({ ...fsServer, ...over });
  const bad = (over: Record<string, unknown>): string => {
    try {
      ok(over);
    } catch (err) {
      return codeOf(err);
    }
    return 'no error';
  };

  it('accepts a good stdio and http server', () => {
    expect(ok({}).command).toBe('npx');
    expect(
      ok({ transport: 'http', command: undefined, args: undefined, url: 'https://m.example/mcp', env: [], headers: [{ key: 'Authorization', value: 'x' }] }).url,
    ).toBe('https://m.example/mcp');
  });

  it('rejects bad names, urls, keys, values and transport fits', () => {
    expect(bad({ name: '../x' })).toBe('INVALID_PARAMS');
    expect(bad({ command: '' })).toBe('INVALID_PARAMS');
    expect(bad({ args: 'x' })).toBe('INVALID_PARAMS');
    expect(bad({ env: [{ key: 'A B', value: 'v' }] })).toBe('INVALID_PARAMS');
    expect(bad({ env: [{ key: 'A', value: 'v\nINJECT=1' }] })).toBe('INVALID_PARAMS');
    expect(bad({ env: [{ key: 'A' }, { key: 'a' }] })).toBe('INVALID_PARAMS');
    expect(bad({ headers: [{ key: 'X', value: 'v' }] })).toBe('INVALID_PARAMS');
    const http = { transport: 'http', command: undefined, args: undefined, env: [], headers: [] };
    expect(bad({ ...http, url: 'file:///etc/passwd' })).toBe('INVALID_PARAMS');
    expect(bad({ ...http, url: 'https://u:p@m.example' })).toBe('INVALID_PARAMS');
    expect(bad({ ...http, url: 'https://m.example', env: [{ key: 'A', value: 'v' }] })).toBe('INVALID_PARAMS');
  });
});

const writeClaude = (servers: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  fs.writeFileSync(claudeFile(), JSON.stringify({ ...extra, mcpServers: servers }));
const ghEntry = { type: 'stdio', command: 'gh-mcp', args: [], env: { GH_TOKEN: 'ghp' } };
const rowOf = (snap: McpSnapshot, name: string) => snap.rows.find((r) => r.name === name);

describe('mcp store', () => {
  it('save changes only the library; values never reach the snapshot or the library file', () => {
    const { store, secrets, confirmWrite } = makeStore();
    const snap = store.save(validateSaveRequest(fsServer));
    expect(confirmWrite).not.toHaveBeenCalled();
    expect(fs.existsSync(claudeFile())).toBe(false);
    expect(JSON.stringify(snap)).not.toContain('secret-1');
    expect(fs.readFileSync(path.join(dir, 'mcp-servers.json'), 'utf8')).not.toContain('secret-1');
    expect([...secrets.map.values()].join()).toContain('secret-1');
    expect(rowOf(snap, 'fs')).toMatchObject({
      library: { env: [{ key: 'TOKEN', set: true }] },
      agents: { claude: { state: 'library-only' }, codex: { state: 'library-only' }, gemini: { state: 'library-only' } },
    });
  });

  it('push writes after one confirmation listing every agent; values never in the request', async () => {
    const { store, confirmWrite } = makeStore();
    store.save(validateSaveRequest(fsServer));
    const r = await store.push('fs', ['claude', 'codex']);
    expect(r.saved).toBe(true);
    expect(confirmWrite).toHaveBeenCalledOnce();
    const req = confirmWrite.mock.calls[0]![0][0]!;
    expect(req).toMatchObject({ name: 'fs', agentIds: ['claude', 'codex'], envKeys: ['TOKEN'] });
    expect(JSON.stringify(req)).not.toContain('secret-1');
    expect(claudeServers().fs).toMatchObject({ command: 'npx', env: { TOKEN: 'secret-1' } });
    const codex = readAgentMcp('codex');
    expect(codex.state === 'ok' && codex.servers.get('fs')?.env).toEqual({ TOKEN: 'secret-1' });
    expect(rowOf(r.snapshot, 'fs')!.agents).toMatchObject({ claude: { state: 'same' }, codex: { state: 'same' }, gemini: { state: 'library-only' } });
    expect(JSON.stringify(r.snapshot)).not.toContain('secret-1');
  });

  it('a declined push writes nothing', async () => {
    const { store } = makeStore({ confirm: false });
    store.save(validateSaveRequest(fsServer));
    const r = await store.push('fs', ['claude']);
    expect(r.saved).toBe(false);
    expect(fs.existsSync(claudeFile())).toBe(false);
  });

  it('push refuses an agent that cannot take the transport, before confirming', async () => {
    const { store, confirmWrite } = makeStore();
    store.save(validateSaveRequest({ name: 'web', transport: 'sse', url: 'https://m.example/sse', env: [], headers: [] }));
    expect(rowOf(store.snapshot(), 'web')!.agents.codex).toMatchObject({ supported: false });
    await expect(store.push('web', ['codex'])).rejects.toSatisfy((e) => codeOf(e) === 'UNSUPPORTED_CAPABILITY');
    expect(confirmWrite).not.toHaveBeenCalled();
  });

  it('editing the library leaves agent files alone; the agent shows differs until pushed', async () => {
    const { store, confirmWrite } = makeStore();
    store.save(validateSaveRequest(fsServer));
    await store.push('fs', ['claude']);
    const before = fs.readFileSync(claudeFile(), 'utf8');
    confirmWrite.mockClear();
    const snap = store.save(validateSaveRequest({ ...fsServer, originalName: 'fs', command: 'node' }));
    expect(confirmWrite).not.toHaveBeenCalled();
    expect(fs.readFileSync(claudeFile(), 'utf8')).toBe(before);
    expect(rowOf(snap, 'fs')!.agents.claude!.state).toBe('differs');
  });

  it('omitted values keep the stored value; rename moves the secret, not agent entries', async () => {
    const { store, secrets } = makeStore();
    store.save(validateSaveRequest(fsServer));
    await store.push('fs', ['claude']);
    const snap = store.save(validateSaveRequest({ ...fsServer, name: 'files', originalName: 'fs', env: [{ key: 'TOKEN' }] }));
    expect(Object.keys(claudeServers())).toEqual(['fs']);
    expect(rowOf(snap, 'fs')).toMatchObject({ library: null, agents: { claude: { state: 'agent-only' } } });
    expect(rowOf(snap, 'files')!.library!.env).toEqual([{ key: 'TOKEN', set: true }]);
    expect(secrets.map.size).toBe(1);
    const r = store.save(validateSaveRequest({ ...fsServer, name: 'files', originalName: 'files', env: [{ key: 'OTHER' }] }));
    expect(rowOf(r, 'files')!.library!.env).toEqual([{ key: 'OTHER', set: false }]);
    expect(secrets.map.size).toBe(0);
  });

  it('save refuses duplicates and missing originals', () => {
    const { store } = makeStore();
    store.save(validateSaveRequest(fsServer));
    const codeFrom = (fn: () => unknown): string => {
      try {
        fn();
      } catch (e) {
        return codeOf(e);
      }
      return 'no error';
    };
    expect(codeFrom(() => store.save(validateSaveRequest(fsServer)))).toBe('ALREADY_EXISTS');
    expect(codeFrom(() => store.save(validateSaveRequest({ ...fsServer, originalName: 'nope' })))).toBe('NOT_FOUND');
  });

  it('the matrix unions library and agent names; an agent-only entry pulls in without writing any file', () => {
    writeClaude({ gh: ghEntry });
    const before = fs.readFileSync(claudeFile(), 'utf8');
    const { store, confirmWrite, secrets } = makeStore();
    const snap = store.snapshot();
    expect(rowOf(snap, 'gh')).toMatchObject({
      library: null,
      agents: { claude: { state: 'agent-only', entry: { command: 'gh-mcp', envKeys: ['GH_TOKEN'] } } },
    });
    expect(rowOf(snap, 'gh')!.agents.codex).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain('ghp');
    const after = store.pull('claude', 'gh');
    expect(rowOf(after, 'gh')).toMatchObject({
      library: { env: [{ key: 'GH_TOKEN', set: true }] },
      agents: { claude: { state: 'same' }, codex: { state: 'library-only' } },
    });
    expect(JSON.stringify(after)).not.toContain('ghp');
    expect([...secrets.map.values()].join()).toContain('ghp');
    expect(fs.readFileSync(claudeFile(), 'utf8')).toBe(before);
    expect(confirmWrite).not.toHaveBeenCalled();
  });

  it('deleting from the library never touches agent files (the reported bug)', () => {
    writeClaude({ gh: ghEntry });
    const { store, secrets } = makeStore();
    store.pull('claude', 'gh');
    const snap = store.remove('gh');
    expect(claudeServers().gh).toMatchObject({ command: 'gh-mcp' });
    expect(secrets.map.size).toBe(0);
    expect(rowOf(snap, 'gh')).toMatchObject({ library: null, agents: { claude: { state: 'agent-only' } } });
    // ...so it can be pulled again.
    expect(rowOf(store.pull('claude', 'gh'), 'gh')!.agents.claude!.state).toBe('same');
  });

  it('deleteAgent removes only that agent’s entry and keeps other keys', async () => {
    const { store, confirmWrite } = makeStore();
    store.save(validateSaveRequest(fsServer));
    await store.push('fs', ['claude', 'codex']);
    writeClaude({ ...claudeServers(), gh: ghEntry }, { theme: 'dark' });
    confirmWrite.mockClear();
    const snap = store.removeFromAgent('claude', 'fs');
    expect(confirmWrite).not.toHaveBeenCalled();
    expect(Object.keys(claudeServers())).toEqual(['gh']);
    expect(JSON.parse(fs.readFileSync(claudeFile(), 'utf8')).theme).toBe('dark');
    expect(rowOf(snap, 'fs')!.agents).toMatchObject({ claude: { state: 'library-only' }, codex: { state: 'same' } });
    expect(() => store.removeFromAgent('gemini', 'fs')).toThrow();
  });

  it('diff lists differing fields without values; merge takes picked agent fields into the library only', async () => {
    const { store } = makeStore();
    store.save(validateSaveRequest({ ...fsServer, env: [{ key: 'TOKEN', value: 'secret-1' }, { key: 'KEEP', value: 'k' }] }));
    await store.push('fs', ['claude']);
    const doc = JSON.parse(fs.readFileSync(claudeFile(), 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
    doc.mcpServers.fs = { ...doc.mcpServers.fs, command: 'node', env: { TOKEN: 'secret-2', NEW: 'n' } };
    fs.writeFileSync(claudeFile(), JSON.stringify(doc));
    const before = fs.readFileSync(claudeFile(), 'utf8');

    const d = store.diff('claude', 'fs');
    expect(d.fields.map((f) => [f.field, f.status])).toEqual([
      ['spec', 'modified'],
      ['env:KEEP', 'added'],
      ['env:NEW', 'deleted'],
      ['env:TOKEN', 'modified'],
    ]);
    expect(d.fields[0]).toMatchObject({ library: 'npx -y server-fs', agent: 'node -y server-fs' });
    expect(JSON.stringify(d)).not.toMatch(/secret-|"n"|"k"/);

    // Take the agent's TOKEN and NEW, drop nothing else; an unknown pick is ignored.
    let snap = store.merge('claude', 'fs', ['env:TOKEN', 'env:NEW', 'env:BOGUS']);
    expect(fs.readFileSync(claudeFile(), 'utf8')).toBe(before);
    expect(rowOf(snap, 'fs')!.library).toMatchObject({ command: 'npx', env: [{ key: 'TOKEN', set: true }, { key: 'KEEP', set: true }, { key: 'NEW', set: true }] });
    expect(store.diff('claude', 'fs').fields.map((f) => f.field)).toEqual(['spec', 'env:KEEP']);

    // Taking the rest makes them the same.
    snap = store.merge('claude', 'fs', ['spec', 'env:KEEP']);
    expect(rowOf(snap, 'fs')!.agents.claude!.state).toBe('same');
    expect(rowOf(snap, 'fs')!.library!.env.map((v) => v.key)).toEqual(['TOKEN', 'NEW']);
  });

  it('refuses to write over an unreadable agent file, before confirming', async () => {
    const { store, confirmWrite } = makeStore();
    store.save(validateSaveRequest(fsServer));
    fs.writeFileSync(claudeFile(), '{ broken');
    await expect(store.push('fs', ['claude'])).rejects.toSatisfy((e) => codeOf(e) === 'PRECONDITION_FAILED');
    expect(() => store.removeFromAgent('claude', 'fs')).toThrow();
    expect(confirmWrite).not.toHaveBeenCalled();
    expect(fs.readFileSync(claudeFile(), 'utf8')).toBe('{ broken');
    const snap = store.snapshot();
    expect(snap.agents.find((a) => a.agentId === 'claude')!.unreadable).toBe(true);
    expect(rowOf(snap, 'fs')!.agents.claude).toBeUndefined();
  });

  it('refuses values when secret encryption is unavailable', () => {
    writeClaude({ gh: ghEntry });
    const { store } = makeStore({ secrets: memorySecrets(false) });
    expect(() => store.save(validateSaveRequest(fsServer))).toThrow();
    expect(() => store.pull('claude', 'gh')).toThrow();
    expect(rowOf(store.save(validateSaveRequest({ ...fsServer, env: [] })), 'fs')!.library).not.toBeNull();
  });

  it('ignores a corrupt library file', () => {
    fs.writeFileSync(path.join(dir, 'mcp-servers.json'), '{"servers":[{"name":"../x","transport":"stdio","command":"c"},{"name":"ok","transport":"stdio","command":"c"}]}');
    expect(makeStore().store.snapshot().rows.map((r) => r.name)).toEqual(['ok']);
  });
});

describe('mcp IPC', () => {
  const trusted: IpcInvokeMeta = { assertTrustedSender: () => {} };
  const untrusted: IpcInvokeMeta = { assertTrustedSender: () => throwIpcError('PERMISSION_DENIED', 'nope') };

  it('rejects an untrusted sender before any side effect', async () => {
    writeClaude({ gh: ghEntry });
    const before = fs.readFileSync(claudeFile(), 'utf8');
    const { store, confirmWrite } = makeStore();
    const reg = createInMemoryRegistry();
    registerMcpIpc(reg, store);
    const calls: [string, unknown][] = [
      [IPC_CHANNELS.mcpGet, undefined],
      [IPC_CHANNELS.mcpSave, fsServer],
      [IPC_CHANNELS.mcpPull, { agentId: 'claude', name: 'gh' }],
      [IPC_CHANNELS.mcpPush, { name: 'gh', agentIds: ['claude'] }],
      [IPC_CHANNELS.mcpDelete, { name: 'gh' }],
      [IPC_CHANNELS.mcpDeleteAgent, { agentId: 'claude', name: 'gh' }],
      [IPC_CHANNELS.mcpDiff, { agentId: 'claude', name: 'gh' }],
      [IPC_CHANNELS.mcpMerge, { agentId: 'claude', name: 'gh', agentPicks: ['spec'] }],
    ];
    for (const [ch, payload] of calls) {
      await expect(reg.invoke(ch, payload, untrusted)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    expect(confirmWrite).not.toHaveBeenCalled();
    expect(fs.readFileSync(claudeFile(), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dir, 'mcp-servers.json'))).toBe(false);
  });

  it('validates payloads', async () => {
    const { store } = makeStore();
    const reg = createInMemoryRegistry();
    registerMcpIpc(reg, store);
    const invalid = async (ch: string, payload: unknown) =>
      expect(reg.invoke(ch, payload, trusted)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await invalid(IPC_CHANNELS.mcpPull, { agentId: 'pi', name: 'fs' });
    await invalid(IPC_CHANNELS.mcpPush, { name: 'fs', agentIds: [] });
    await invalid(IPC_CHANNELS.mcpPush, { name: 'fs', agentIds: ['claude', 'pi'] });
    await invalid(IPC_CHANNELS.mcpDeleteAgent, { agentId: 'claude', name: '../x' });
    await invalid(IPC_CHANNELS.mcpMerge, { agentId: 'claude', name: 'fs', agentPicks: 'spec' });
    await invalid(IPC_CHANNELS.mcpMerge, { agentId: 'claude', name: 'fs', agentPicks: [1] });
    await invalid(IPC_CHANNELS.mcpDelete, { name: '../x' });
    await invalid(IPC_CHANNELS.mcpSave, { ...fsServer, command: 7 });
    await expect(reg.invoke(IPC_CHANNELS.mcpGet, undefined, trusted)).resolves.toMatchObject({ rows: [] });
  });
});

describe('mcp confirm content', () => {
  const req: McpConfirmRequest = {
    name: 'fs',
    summary: 'npx -y server-fs',
    transport: 'stdio',
    agentIds: ['claude', 'codex'],
    envKeys: ['TOKEN'],
    headerKeys: [],
  };

  it('names the server, agents, command and keys', () => {
    const c = buildMcpConfirm('en-US', [req]);
    expect(c.message).toContain('fs');
    expect(c.message).toContain('Claude Code');
    expect(c.detail).toContain('npx -y server-fs');
    expect(c.detail).toContain('TOKEN');
  });

  it('localizes, falls back to English, and marks a cut spec', () => {
    expect(buildMcpConfirm('zh-CN', [req]).cancel).not.toBe(buildMcpConfirm('en', [req]).cancel);
    expect(buildMcpConfirm('xx', [req]).title).toBe(buildMcpConfirm('en', [req]).title);
    const long = buildMcpConfirm('en', [{ ...req, summary: 'a'.repeat(5000) }]);
    expect(long.detail).toContain('…');
    expect(long.detail.length).toBeLessThan(2600);
  });

  it('several servers share one dialog that lists each of them', () => {
    const many = buildMcpConfirm('en', [req, { ...req, name: 'web', transport: 'http', summary: 'https://m.example/mcp', agentIds: ['gemini'], envKeys: [], headerKeys: ['Authorization'] }]);
    expect(many.message).toContain('2');
    expect(many.detail).toContain('fs → Claude Code, Codex');
    expect(many.detail).toContain('web → Gemini CLI');
    expect(many.detail).toContain('https://m.example/mcp');
    expect(many.detail).toContain('Authorization');
  });
});

describe('mcp enabled sets (config profiles)', () => {
  const web: McpSaveRequest = { name: 'web', transport: 'sse', url: 'https://m.example/sse', env: [], headers: [] };

  it('captures the library servers each agent file has', async () => {
    writeClaude({ gh: ghEntry });
    const { store } = makeStore();
    store.save(validateSaveRequest(fsServer));
    store.save(validateSaveRequest(web));
    await store.push('fs', ['claude', 'codex']);
    await store.push('web', ['claude']);
    // `gh` is only in Claude's file, not the library: profiles do not record it.
    expect(store.enabledSets()).toEqual({ claude: ['fs', 'web'], codex: ['fs'], gemini: [] });
  });

  it('applies a set with one confirmation for all adds; removals need none; hand-written entries stay', async () => {
    writeClaude({ gh: ghEntry });
    const { store, confirmWrite } = makeStore();
    store.save(validateSaveRequest(fsServer));
    store.save(validateSaveRequest(web));
    await store.push('web', ['claude']);
    confirmWrite.mockClear();
    const plan = await store.planEnabledSets({ claude: ['fs', 'gone'], codex: ['fs', 'web'], gemini: ['fs'] });
    expect(confirmWrite).toHaveBeenCalledOnce();
    const reqs = confirmWrite.mock.calls[0]![0];
    expect(reqs.map((r) => [r.name, r.agentIds])).toEqual([['fs', ['claude', 'codex', 'gemini']]]);
    // 'gone' is not in the library; 'web' is sse, which codex cannot take.
    expect(plan).toMatchObject({ proceed: true, skipped: 2 });
    expect(store.enabledSets().claude).toEqual(['web']); // nothing changed before commit
    plan.commit();
    expect(store.enabledSets()).toEqual({ claude: ['fs'], codex: ['fs'], gemini: ['fs'] });
    expect(Object.keys(claudeServers()).sort()).toEqual(['fs', 'gh']);
    const codex = readAgentMcp('codex');
    expect(codex.state === 'ok' && [...codex.servers.keys()]).toEqual(['fs']);
  });

  it('remove-only plans and agents absent from the set skip the dialog', async () => {
    const { store, confirmWrite } = makeStore();
    store.save(validateSaveRequest(fsServer));
    await store.push('fs', ['claude', 'codex']);
    confirmWrite.mockClear();
    const plan = await store.planEnabledSets({ claude: [] });
    expect(confirmWrite).not.toHaveBeenCalled();
    plan.commit();
    expect(store.enabledSets()).toEqual({ claude: [], codex: ['fs'], gemini: [] });
  });

  it('a declined plan changes nothing', async () => {
    const { store, confirmWrite } = makeStore();
    store.save(validateSaveRequest(fsServer));
    confirmWrite.mockResolvedValue(false);
    const plan = await store.planEnabledSets({ claude: ['fs'] });
    expect(plan.proceed).toBe(false);
    plan.commit();
    expect(store.enabledSets().claude).toEqual([]);
    expect(fs.existsSync(claudeFile())).toBe(false);
  });

  it('a spec edited while the dialog was open is not written unconfirmed', async () => {
    const { store, confirmWrite } = makeStore();
    store.save(validateSaveRequest(fsServer));
    let release!: (v: boolean) => void;
    confirmWrite.mockImplementationOnce(() => new Promise<boolean>((r) => (release = r)));
    const pending = store.planEnabledSets({ claude: ['fs'] });
    await vi.waitFor(() => expect(confirmWrite).toHaveBeenCalledTimes(1));
    store.save(validateSaveRequest({ ...fsServer, originalName: 'fs', command: 'evil' }));
    release(true);
    (await pending).commit();
    expect(store.enabledSets().claude).toEqual([]);
    expect(fs.existsSync(claudeFile())).toBe(false);
  });

  it('an unreadable target refuses before the dialog', async () => {
    const { store, confirmWrite } = makeStore();
    store.save(validateSaveRequest(fsServer));
    fs.writeFileSync(claudeFile(), '{ broken');
    await expect(store.planEnabledSets({ claude: ['fs'] })).rejects.toSatisfy((e) => codeOf(e) === 'PRECONDITION_FAILED');
    expect(confirmWrite).not.toHaveBeenCalled();
  });
});
