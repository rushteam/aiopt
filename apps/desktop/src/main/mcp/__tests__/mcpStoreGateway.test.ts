import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpStore, type McpConfirmRequest } from '../mcpStore';
import { buildMcpGatewayConfirm } from '../mcpConfirm';
import { registerMcpIpc } from '../mcpIpc';
import type { SecretStore } from '../../secrets/secretStore';
import { createInMemoryRegistry, type IpcInvokeMeta } from '../../ipc/registry';
import { throwIpcError } from '../../ipc/validate';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { decodeIpcError, isIpcError } from '../../../shared/ipc-errors';
import type { McpSaveRequest } from '../../../shared/mcp';

let home: string;
let dir: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-mcpgw-home-'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-mcpgw-data-'));
  prevHome = process.env.AIOPT_AGENT_HOME;
  process.env.AIOPT_AGENT_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.AIOPT_AGENT_HOME;
  else process.env.AIOPT_AGENT_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

function memorySecrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    isAvailable: () => true,
    set: (k, v) => void map.set(k, v),
    get: (k) => map.get(k) ?? null,
    has: (k) => map.has(k),
    delete: (k) => void map.delete(k),
  };
}

function makeStore(opts: { confirm?: boolean; enabled?: boolean; noConfirm?: boolean } = {}) {
  const confirmGateway = vi.fn(async (_req: McpConfirmRequest) => opts.confirm ?? true);
  const onLibraryChange = vi.fn();
  const store = createMcpStore({
    filePath: path.join(dir, 'mcp-servers.json'),
    secrets: memorySecrets(),
    confirmWrite: async () => true,
    ...(opts.noConfirm ? {} : { confirmGateway }),
    onLibraryChange,
    isInstalled: () => true,
    displayPath: (p) => p,
    gateway: {
      enabled: () => opts.enabled ?? true,
      url: () => 'http://127.0.0.1:4000/tok/mcp',
      status: () => ({}),
    },
  });
  return { store, confirmGateway, onLibraryChange };
}

const fsServer: McpSaveRequest = {
  name: 'fs',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server-fs'],
  env: [{ key: 'TOKEN', value: 'secret-1' }],
  headers: [],
};

const codeOf = (err: unknown): string => (isIpcError(err) ? err.code : decodeIpcError((err as Error).message).code);
const claudeServers = (): Record<string, Record<string, unknown>> =>
  ((JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')) as { mcpServers?: object }).mcpServers ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

describe('mcp store: gateway membership', () => {
  it('is off by default and serves nothing', () => {
    const { store } = makeStore();
    store.save(fsServer);
    expect(store.snapshot().rows[0]!.library!.gateway).toBe('off');
    expect(store.gatewayServers()).toEqual([]);
  });

  it('adding confirms natively with the spec and key names only, then serves with values', async () => {
    const { store, confirmGateway } = makeStore();
    store.save(fsServer);
    const r = await store.setGateway('fs', true);
    expect(r.saved).toBe(true);
    const req = confirmGateway.mock.calls[0]![0];
    expect(req.envKeys).toEqual(['TOKEN']);
    expect(JSON.stringify(req)).not.toContain('secret-1');
    expect(r.snapshot.rows[0]!.library!.gateway).toBe('on');
    const [served] = store.gatewayServers();
    expect(served!.live.env).toEqual({ TOKEN: 'secret-1' });
    expect(served!.version).not.toContain('secret-1');
  });

  it('a declined or unconfirmable add serves nothing', async () => {
    const declined = makeStore({ confirm: false });
    declined.store.save(fsServer);
    expect((await declined.store.setGateway('fs', true)).saved).toBe(false);
    expect(declined.store.gatewayServers()).toEqual([]);

    fs.rmSync(path.join(dir, 'mcp-servers.json'));
    const noDialog = makeStore({ noConfirm: true });
    noDialog.store.save(fsServer);
    expect((await noDialog.store.setGateway('fs', true)).saved).toBe(false);
    expect(noDialog.store.gatewayServers()).toEqual([]);
  });

  it('a spec edit makes it stale (not served) until confirmed again; a value edit does not', async () => {
    const { store, confirmGateway } = makeStore();
    store.save(fsServer);
    await store.setGateway('fs', true);
    store.save({ ...fsServer, originalName: 'fs', env: [{ key: 'TOKEN', value: 'secret-2' }] });
    expect(store.gatewayServers()[0]!.live.env).toEqual({ TOKEN: 'secret-2' });
    store.save({ ...fsServer, originalName: 'fs', args: ['-y', 'other'], env: [{ key: 'TOKEN' }] });
    expect(store.snapshot().rows[0]!.library!.gateway).toBe('stale');
    expect(store.gatewayServers()).toEqual([]);
    await store.setGateway('fs', true);
    expect(confirmGateway).toHaveBeenCalledTimes(2);
    expect(store.gatewayServers()).toHaveLength(1);
  });

  it('removing needs no confirmation, and the library change is announced', async () => {
    const { store, confirmGateway, onLibraryChange } = makeStore();
    store.save(fsServer);
    await store.setGateway('fs', true);
    onLibraryChange.mockClear();
    expect((await store.setGateway('fs', false)).saved).toBe(true);
    expect(confirmGateway).toHaveBeenCalledTimes(1);
    expect(onLibraryChange).toHaveBeenCalled();
    expect(store.gatewayServers()).toEqual([]);
  });
});

describe('mcp store: the reserved gateway entry', () => {
  it('refuses a library server named aiopt', () => {
    const { store } = makeStore();
    try {
      store.save({ ...fsServer, name: 'AiOpt' });
      throw new Error('no error');
    } catch (err) {
      expect(codeOf(err)).toBe('ALREADY_EXISTS');
    }
  });

  it('writes, reports and removes the agent entry; it is never a matrix row', () => {
    const { store } = makeStore();
    const snap = store.setGatewayAgents(['claude'], true);
    expect(claudeServers().aiopt).toMatchObject({ type: 'http', url: 'http://127.0.0.1:4000/tok/mcp' });
    expect(snap.gateway.agents.claude).toBe('same');
    expect(snap.rows.map((r) => r.name)).not.toContain('aiopt');
    expect(() => store.pull('claude', 'aiopt')).toThrow();
    store.setGatewayAgents(['claude'], false);
    expect(claudeServers().aiopt).toBeUndefined();
  });

  it('refuses to add the agent entry while the gateway is off', () => {
    const { store } = makeStore({ enabled: false });
    expect(() => store.setGatewayAgents(['claude'], true)).toThrow();
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
  });

  it('flags an entry pointing at an old endpoint as stale', () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { aiopt: { type: 'http', url: 'http://127.0.0.1:1/old/mcp' } } }));
    const { store } = makeStore();
    expect(store.snapshot().gateway.agents.claude).toBe('stale');
  });
});

describe('mcp ipc: gateway channels', () => {
  const trusted: IpcInvokeMeta = { assertTrustedSender: () => {} };
  const untrusted: IpcInvokeMeta = { assertTrustedSender: () => throwIpcError('PERMISSION_DENIED', 'nope') };

  it('rejects an untrusted sender before any side effect, and validates payloads', async () => {
    const { store, confirmGateway } = makeStore();
    store.save(fsServer);
    const registry = createInMemoryRegistry();
    registerMcpIpc(registry, store);
    await expect(registry.invoke(IPC_CHANNELS.mcpGatewayServer, { name: 'fs', on: true }, untrusted)).rejects.toThrow();
    await expect(registry.invoke(IPC_CHANNELS.mcpGatewayAgents, { agentIds: ['claude'], on: true }, untrusted)).rejects.toThrow();
    expect(confirmGateway).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
    await expect(registry.invoke(IPC_CHANNELS.mcpGatewayServer, { name: 'fs', on: 'yes' }, trusted)).rejects.toThrow();
    await expect(registry.invoke(IPC_CHANNELS.mcpGatewayAgents, { agentIds: ['nope'], on: true }, trusted)).rejects.toThrow();
  });
});

describe('gateway confirmation dialog', () => {
  it('names the server, the spec and key names, and says AiOpt runs it', () => {
    const c = buildMcpGatewayConfirm('en', { name: 'fs', summary: 'npx -y server-fs', transport: 'stdio', agentIds: [], envKeys: ['TOKEN'], headerKeys: [] });
    expect(c.message).toContain('fs');
    expect(c.detail).toContain('npx -y server-fs');
    expect(c.detail).toContain('TOKEN');
    expect(c.detail).toContain('AiOpt');
    expect(buildMcpGatewayConfirm('zh-CN', { name: 'fs', summary: 'x', transport: 'stdio', agentIds: [], envKeys: [], headerKeys: [] }).cancel).toBe('取消');
  });
});
