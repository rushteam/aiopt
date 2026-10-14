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
import type { McpSaveRequest } from '../../../shared/mcp';

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
  const confirmWrite = vi.fn(async (_req: McpConfirmRequest) => opts.confirm ?? true);
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
  agents: ['claude', 'codex'],
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
    expect(bad({ ...http, transport: 'sse', url: 'https://m.example', agents: ['codex'] })).toBe('UNSUPPORTED_CAPABILITY');
    expect(bad({ agents: ['pi'] })).toBe('INVALID_PARAMS');
  });
});

describe('mcp store', () => {
  it('save writes enabled agents after confirmation; values never reach the snapshot', async () => {
    const { store, secrets, confirmWrite } = makeStore();
    const r = await store.save(validateSaveRequest(fsServer));
    expect(r.saved).toBe(true);
    expect(confirmWrite).toHaveBeenCalledOnce();
    const req = confirmWrite.mock.calls[0]![0];
    expect(req).toMatchObject({ name: 'fs', agentIds: ['claude', 'codex'], envKeys: ['TOKEN'] });
    expect(JSON.stringify(req)).not.toContain('secret-1');

    expect(claudeServers().fs).toMatchObject({ command: 'npx', env: { TOKEN: 'secret-1' } });
    const codex = readAgentMcp('codex');
    expect(codex.state === 'ok' && codex.servers.get('fs')?.env).toEqual({ TOKEN: 'secret-1' });

    expect(JSON.stringify(r.snapshot)).not.toContain('secret-1');
    expect(fs.readFileSync(path.join(dir, 'mcp-servers.json'), 'utf8')).not.toContain('secret-1');
    expect([...secrets.map.values()].join()).toContain('secret-1');
    expect(r.snapshot.servers[0]).toMatchObject({
      env: [{ key: 'TOKEN', set: true }],
      agents: { claude: 'synced', codex: 'synced', gemini: 'off' },
    });
  });

  it('a declined confirmation writes nothing anywhere', async () => {
    const { store, secrets } = makeStore({ confirm: false });
    const r = await store.save(validateSaveRequest(fsServer));
    expect(r.saved).toBe(false);
    expect(r.snapshot.servers).toEqual([]);
    expect(fs.existsSync(claudeFile())).toBe(false);
    expect(fs.existsSync(path.join(dir, 'mcp-servers.json'))).toBe(false);
    expect(secrets.map.size).toBe(0);
  });

  it('omitted values keep the stored value; rename moves the secret and the agent entry', async () => {
    const { store, secrets } = makeStore();
    await store.save(validateSaveRequest(fsServer));
    await store.save(validateSaveRequest({ ...fsServer, name: 'files', originalName: 'fs', env: [{ key: 'TOKEN' }], agents: ['claude'] }));
    expect(Object.keys(claudeServers())).toEqual(['files']);
    expect(claudeServers().files!.env).toEqual({ TOKEN: 'secret-1' });
    const codex = readAgentMcp('codex');
    expect(codex.state === 'ok' && codex.servers.size).toBe(0);
    expect(secrets.map.size).toBe(1);
    // A new key with no value is listed but not set.
    const r = await store.save(validateSaveRequest({ ...fsServer, name: 'files', originalName: 'files', env: [{ key: 'OTHER' }], agents: ['claude'] }));
    expect(r.snapshot.servers[0]!.env).toEqual([{ key: 'OTHER', set: false }]);
    expect(secrets.map.size).toBe(0);
  });

  it('save refuses duplicates and missing originals', async () => {
    const { store } = makeStore();
    await store.save(validateSaveRequest(fsServer));
    await expect(store.save(validateSaveRequest(fsServer))).rejects.toSatisfy((e) => codeOf(e) === 'ALREADY_EXISTS');
    await expect(store.save(validateSaveRequest({ ...fsServer, originalName: 'nope' }))).rejects.toSatisfy((e) => codeOf(e) === 'NOT_FOUND');
  });

  it('toggle on confirms and writes; toggle off removes without asking', async () => {
    const { store, confirmWrite } = makeStore();
    await store.save(validateSaveRequest({ ...fsServer, agents: [] }));
    expect(confirmWrite).not.toHaveBeenCalled();
    expect(fs.existsSync(claudeFile())).toBe(false);
    let r = await store.toggle('fs', 'claude', true);
    expect(confirmWrite).toHaveBeenCalledOnce();
    expect(r.snapshot.servers[0]!.agents.claude).toBe('synced');
    r = await store.toggle('fs', 'claude', false);
    expect(confirmWrite).toHaveBeenCalledOnce();
    expect(claudeServers()).toEqual({});
    expect(r.snapshot.servers[0]!.agents.claude).toBe('off');
  });

  it('toggle declined leaves the agent off', async () => {
    const { store } = makeStore({ confirm: false });
    await store.save(validateSaveRequest({ ...fsServer, agents: [] }));
    const r = await store.toggle('fs', 'claude', true);
    expect(r.saved).toBe(false);
    expect(r.snapshot.servers[0]!.agents.claude).toBe('off');
    expect(fs.existsSync(claudeFile())).toBe(false);
  });

  it('detects drift and resync repairs it', async () => {
    const { store } = makeStore();
    await store.save(validateSaveRequest(fsServer));
    const doc = JSON.parse(fs.readFileSync(claudeFile(), 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
    doc.mcpServers.fs!.command = 'evil';
    fs.writeFileSync(claudeFile(), JSON.stringify(doc));
    expect(store.snapshot().servers[0]!.agents.claude).toBe('different');
    fs.writeFileSync(claudeFile(), JSON.stringify({}));
    expect(store.snapshot().servers[0]!.agents.claude).toBe('missing');
    expect(store.resync('fs').servers[0]!.agents.claude).toBe('synced');
  });

  it('refuses to write over an unreadable agent file, before confirming', async () => {
    const { store, confirmWrite } = makeStore();
    fs.writeFileSync(claudeFile(), '{ broken');
    await expect(store.save(validateSaveRequest(fsServer))).rejects.toSatisfy((e) => codeOf(e) === 'PRECONDITION_FAILED');
    expect(confirmWrite).not.toHaveBeenCalled();
    expect(fs.readFileSync(claudeFile(), 'utf8')).toBe('{ broken');
    expect(store.snapshot().agents.find((a) => a.agentId === 'claude')!.unreadable).toBe(true);
  });

  it('refuses values when secret encryption is unavailable, before confirming', async () => {
    const { store, confirmWrite } = makeStore({ secrets: memorySecrets(false) });
    await expect(store.save(validateSaveRequest(fsServer))).rejects.toSatisfy((e) => codeOf(e) === 'PRECONDITION_FAILED');
    expect(confirmWrite).not.toHaveBeenCalled();
    // Without values it still works.
    expect((await store.save(validateSaveRequest({ ...fsServer, env: [] }))).saved).toBe(true);
  });

  it('remove drops the server from agents, the library and the secret store', async () => {
    const { store, secrets } = makeStore();
    await store.save(validateSaveRequest(fsServer));
    expect(store.remove('fs').servers).toEqual([]);
    expect(claudeServers()).toEqual({});
    expect(secrets.map.size).toBe(0);
  });

  it('import adopts an agent’s server without writing any agent file', async () => {
    fs.writeFileSync(claudeFile(), JSON.stringify({ mcpServers: { gh: { type: 'stdio', command: 'gh-mcp', args: [], env: { GH_TOKEN: 'ghp' } } } }));
    const before = fs.readFileSync(claudeFile(), 'utf8');
    const { store, confirmWrite, secrets } = makeStore();
    const snap = store.snapshot();
    expect(snap.candidates).toEqual([{ agentId: 'claude', name: 'gh', transport: 'stdio', summary: expect.any(String) }]);
    const after = store.import('claude', 'gh');
    expect(after.candidates).toEqual([]);
    expect(after.servers[0]).toMatchObject({ name: 'gh', env: [{ key: 'GH_TOKEN', set: true }], agents: { claude: 'synced' } });
    expect(JSON.stringify(after)).not.toContain('ghp');
    expect([...secrets.map.values()].join()).toContain('ghp');
    expect(fs.readFileSync(claudeFile(), 'utf8')).toBe(before);
    expect(confirmWrite).not.toHaveBeenCalled();
    expect(() => store.import('claude', 'gh')).toThrow();
  });

  it('ignores a corrupt library file', () => {
    fs.writeFileSync(path.join(dir, 'mcp-servers.json'), '{"servers":[{"name":"../x","transport":"stdio","command":"c"},{"name":"ok","transport":"stdio","command":"c"}]}');
    expect(makeStore().store.snapshot().servers.map((s) => s.name)).toEqual(['ok']);
  });
});

describe('mcp IPC', () => {
  const trusted: IpcInvokeMeta = { assertTrustedSender: () => {} };
  const untrusted: IpcInvokeMeta = { assertTrustedSender: () => throwIpcError('PERMISSION_DENIED', 'nope') };

  it('rejects an untrusted sender before any side effect', async () => {
    const { store, confirmWrite } = makeStore();
    const reg = createInMemoryRegistry();
    registerMcpIpc(reg, store);
    const calls: [string, unknown][] = [
      [IPC_CHANNELS.mcpGet, undefined],
      [IPC_CHANNELS.mcpSave, fsServer],
      [IPC_CHANNELS.mcpToggle, { name: 'fs', agentId: 'claude', enabled: true }],
      [IPC_CHANNELS.mcpResync, { name: 'fs' }],
      [IPC_CHANNELS.mcpDelete, { name: 'fs' }],
      [IPC_CHANNELS.mcpImport, { agentId: 'claude', name: 'fs' }],
    ];
    for (const [ch, payload] of calls) {
      await expect(reg.invoke(ch, payload, untrusted)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    expect(confirmWrite).not.toHaveBeenCalled();
    expect(fs.existsSync(claudeFile())).toBe(false);
  });

  it('validates payloads', async () => {
    const { store } = makeStore();
    const reg = createInMemoryRegistry();
    registerMcpIpc(reg, store);
    await expect(reg.invoke(IPC_CHANNELS.mcpToggle, { name: 'fs', agentId: 'pi', enabled: true }, trusted)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(reg.invoke(IPC_CHANNELS.mcpToggle, { name: 'fs', agentId: 'claude', enabled: 'yes' }, trusted)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(reg.invoke(IPC_CHANNELS.mcpDelete, { name: '../x' }, trusted)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(reg.invoke(IPC_CHANNELS.mcpSave, { ...fsServer, command: 7 }, trusted)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(reg.invoke(IPC_CHANNELS.mcpGet, undefined, trusted)).resolves.toMatchObject({ servers: [] });
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
    const c = buildMcpConfirm('en-US', req);
    expect(c.message).toContain('fs');
    expect(c.message).toContain('Claude Code');
    expect(c.detail).toContain('npx -y server-fs');
    expect(c.detail).toContain('TOKEN');
  });

  it('localizes, falls back to English, and marks a cut spec', () => {
    expect(buildMcpConfirm('zh-CN', req).cancel).not.toBe(buildMcpConfirm('en', req).cancel);
    expect(buildMcpConfirm('xx', req).title).toBe(buildMcpConfirm('en', req).title);
    const long = buildMcpConfirm('en', { ...req, summary: 'a'.repeat(5000) });
    expect(long.detail).toContain('…');
    expect(long.detail.length).toBeLessThan(2600);
  });
});
