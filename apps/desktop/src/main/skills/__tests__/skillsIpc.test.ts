import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInMemoryRegistry,
  type InMemoryIpcRegistry,
  type IpcInvokeMeta,
} from '../../ipc/registry';
import { throwIpcError } from '../../ipc/validate';
import { decodeIpcError, isIpcError } from '../../../shared/ipc-errors';
import { registerSkillsIpc, type SkillsIpcDeps } from '../skillsIpc';
import { createSkillsStore, type SkillsStore } from '../skillsStore';
import { createNodeSkillsFs, SKILL_MARKER } from '../skillsFs';
import { AGENT_SKILL_DIRS } from '../../../shared/skills';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { AgentId } from '../../../shared/aiProviders';
import type { SkillsSnapshot } from '../../../shared/skills';

const trusted: IpcInvokeMeta = { assertTrustedSender: () => {} };
const untrusted: IpcInvokeMeta = {
  assertTrustedSender: () => throwIpcError('PERMISSION_DENIED', 'nope'),
};

let root: string;
let home: string;
let central: string;
let store: SkillsStore;
let reg: InMemoryIpcRegistry;
let deps: SkillsIpcDeps;
let pickImportDir: ReturnType<typeof vi.fn>;
let openPath: ReturnType<typeof vi.fn>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-skipc-'));
  home = path.join(root, 'home');
  central = path.join(root, 'central');
  fs.mkdirSync(home, { recursive: true });
  store = createSkillsStore({
    fs: createNodeSkillsFs(),
    homeDir: home,
    getLibraryLocation: () => 'app',
    centralDirFor: () => central,
    now: () => 1000,
  });
  pickImportDir = vi.fn(async () => null as string | null);
  openPath = vi.fn(async () => {});
  deps = { pickImportDir, openPath };
  reg = createInMemoryRegistry();
  registerSkillsIpc(reg, store, deps);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function agentSkillsDir(agentId: AgentId): string {
  const rel = AGENT_SKILL_DIRS[agentId];
  if (rel === null) throw new Error('agent has no dir');
  return path.join(home, rel);
}

function writeSkill(base: string, name: string, meta: string, files: Record<string, string> = {}): void {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SKILL_MARKER), meta);
  for (const [rel, contents] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }
}

/** Invoke a channel and return the coded error of the rejection (or throw if it resolved). */
async function codeOfInvoke(channel: string, payload: unknown, meta: IpcInvokeMeta): Promise<string> {
  try {
    await reg.invoke(channel, payload, meta);
  } catch (err) {
    if (isIpcError(err)) return err.code;
    if (err instanceof Error) return decodeIpcError(err.message).code;
  }
  throw new Error('expected the invoke to reject with a coded error');
}

describe('skills IPC — authorization', () => {
  it('every channel asserts the trusted sender first', async () => {
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n');
    const cases: Array<[string, unknown]> = [
      [IPC_CHANNELS.skillsGet, undefined],
      [IPC_CHANNELS.skillsPull, { agentId: 'claude', name: 'foo' }],
      [IPC_CHANNELS.skillsPush, { name: 'foo', agentIds: ['codex'] }],
      [IPC_CHANNELS.skillsImport, undefined],
      [IPC_CHANNELS.skillsDelete, { name: 'foo' }],
      [IPC_CHANNELS.skillsDeleteAgent, { agentId: 'claude', name: 'foo' }],
      [IPC_CHANNELS.skillsDiff, { agentId: 'claude', name: 'foo' }],
      [IPC_CHANNELS.skillsFileContent, { agentId: 'claude', name: 'foo', side: 'central', relPath: 'a.txt' }],
      [IPC_CHANNELS.skillsMerge, { agentId: 'claude', name: 'foo', agentPicks: [] }],
      [IPC_CHANNELS.skillsReveal, { scope: 'central' }],
    ];
    for (const [channel, payload] of cases) {
      expect(await codeOfInvoke(channel, payload, untrusted)).toBe('PERMISSION_DENIED');
    }
    // The import picker must never run for an untrusted caller.
    expect(pickImportDir).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });
});

describe('skills IPC — get / pull / push', () => {
  it('get returns the snapshot after assertTrustedSender', async () => {
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n');
    const spy = vi.fn();
    const snap = (await reg.invoke(IPC_CHANNELS.skillsGet, undefined, {
      assertTrustedSender: spy,
    })) as SkillsSnapshot;
    expect(spy).toHaveBeenCalledOnce();
    expect(snap.rows.find((r) => r.name === 'foo')?.agents.claude?.state).toBe('agent-only');
  });

  it('pull copies agent → central and returns the fresh snapshot', async () => {
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n', { 'a.txt': '1' });
    const snap = (await reg.invoke(
      IPC_CHANNELS.skillsPull,
      { agentId: 'claude', name: 'foo' },
      trusted,
    )) as SkillsSnapshot;
    expect(fs.existsSync(path.join(central, 'foo', SKILL_MARKER))).toBe(true);
    expect(snap.rows.find((r) => r.name === 'foo')?.agents.claude?.state).toBe('same');
  });

  it('push copies central → each listed agent', async () => {
    writeSkill(central, 'bar', '---\nname: bar\n---\n', { 'y.md': 'Y' });
    await reg.invoke(IPC_CHANNELS.skillsPush, { name: 'bar', agentIds: ['codex', 'gemini'] }, trusted);
    expect(fs.existsSync(path.join(agentSkillsDir('codex'), 'bar', 'y.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentSkillsDir('gemini'), 'bar', 'y.md'))).toBe(true);
  });

  it('deleteAgent removes the agent copy and returns the fresh snapshot', async () => {
    writeSkill(central, 'foo', '---\nname: foo\n---\n');
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n');
    const snap = (await reg.invoke(
      IPC_CHANNELS.skillsDeleteAgent,
      { agentId: 'claude', name: 'foo' },
      trusted,
    )) as SkillsSnapshot;
    expect(fs.existsSync(path.join(agentSkillsDir('claude'), 'foo'))).toBe(false);
    expect(fs.existsSync(path.join(central, 'foo'))).toBe(true);
    // central still has it → the row remains; the claude cell now reads central-only.
    const row = snap.rows.find((r) => r.name === 'foo');
    expect(row?.agents.claude?.state).toBe('central-only');
    expect(row?.agents.claude?.entry).toBeNull();
  });
});

describe('skills IPC — payload validation', () => {
  it('rejects a bad skill name (traversal) with INVALID_PARAMS', async () => {
    expect(
      await codeOfInvoke(IPC_CHANNELS.skillsPull, { agentId: 'claude', name: '../escape' }, trusted),
    ).toBe('INVALID_PARAMS');
    expect(await codeOfInvoke(IPC_CHANNELS.skillsDelete, { name: 'a/b' }, trusted)).toBe(
      'INVALID_PARAMS',
    );
    expect(
      await codeOfInvoke(IPC_CHANNELS.skillsDeleteAgent, { agentId: 'claude', name: '../escape' }, trusted),
    ).toBe('INVALID_PARAMS');
    expect(
      await codeOfInvoke(IPC_CHANNELS.skillsDeleteAgent, { agentId: 'bogus', name: 'foo' }, trusted),
    ).toBe('INVALID_PARAMS');
  });

  it('rejects an unknown agentId with INVALID_PARAMS', async () => {
    expect(
      await codeOfInvoke(IPC_CHANNELS.skillsPull, { agentId: 'bogus', name: 'foo' }, trusted),
    ).toBe('INVALID_PARAMS');
    expect(await codeOfInvoke(IPC_CHANNELS.skillsPush, { name: 'foo', agentIds: [] }, trusted)).toBe(
      'INVALID_PARAMS',
    );
    expect(
      await codeOfInvoke(IPC_CHANNELS.skillsPush, { name: 'foo', agentIds: ['nope'] }, trusted),
    ).toBe('INVALID_PARAMS');
  });

  it('rejects a bad side / non-string relPath on file-content with INVALID_PARAMS', async () => {
    expect(
      await codeOfInvoke(
        IPC_CHANNELS.skillsFileContent,
        { agentId: 'claude', name: 'foo', side: 'elsewhere', relPath: 'a.txt' },
        trusted,
      ),
    ).toBe('INVALID_PARAMS');
    expect(
      await codeOfInvoke(
        IPC_CHANNELS.skillsFileContent,
        { agentId: 'claude', name: 'foo', side: 'central', relPath: 123 },
        trusted,
      ),
    ).toBe('INVALID_PARAMS');
  });

  it('rejects a relPath outside the computed diff on file-content with INVALID_PARAMS', async () => {
    // Both sides identical → nothing differs → any relPath is refused by the store.
    writeSkill(central, 'foo', '---\nname: foo\n---\n', { 'a.txt': 'x' });
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n', { 'a.txt': 'x' });
    expect(
      await codeOfInvoke(
        IPC_CHANNELS.skillsFileContent,
        { agentId: 'claude', name: 'foo', side: 'central', relPath: 'a.txt' },
        trusted,
      ),
    ).toBe('INVALID_PARAMS');
  });

  it('rejects a non-array agentPicks on merge with INVALID_PARAMS', async () => {
    expect(
      await codeOfInvoke(
        IPC_CHANNELS.skillsMerge,
        { agentId: 'claude', name: 'foo', agentPicks: 'a.txt' },
        trusted,
      ),
    ).toBe('INVALID_PARAMS');
    expect(
      await codeOfInvoke(
        IPC_CHANNELS.skillsMerge,
        { agentId: 'claude', name: 'foo', agentPicks: [1] },
        trusted,
      ),
    ).toBe('INVALID_PARAMS');
  });
});

describe('skills IPC — merge', () => {
  it('merges the picked agent files into central and returns the fresh snapshot', async () => {
    writeSkill(central, 'foo', '---\nname: foo\n---\n', { 'mod.txt': 'central' });
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n', { 'mod.txt': 'agent' });
    const snap = (await reg.invoke(
      IPC_CHANNELS.skillsMerge,
      { agentId: 'claude', name: 'foo', agentPicks: ['mod.txt'] },
      trusted,
    )) as SkillsSnapshot;
    expect(fs.readFileSync(path.join(central, 'foo', 'mod.txt'), 'utf8')).toBe('agent');
    // Agent copy untouched.
    expect(fs.readFileSync(path.join(agentSkillsDir('claude'), 'foo', 'mod.txt'), 'utf8')).toBe('agent');
    expect(snap.rows.find((r) => r.name === 'foo')?.agents.claude?.state).toBe('same');
  });

  it('reads a differing file\'s content from the requested side', async () => {
    writeSkill(central, 'foo', '---\nname: foo\n---\n', { 'mod.txt': 'central' });
    writeSkill(agentSkillsDir('claude'), 'foo', '---\nname: foo\n---\n', { 'mod.txt': 'agent' });
    const c = (await reg.invoke(
      IPC_CHANNELS.skillsFileContent,
      { agentId: 'claude', name: 'foo', side: 'central', relPath: 'mod.txt' },
      trusted,
    )) as { text: string | null };
    const a = (await reg.invoke(
      IPC_CHANNELS.skillsFileContent,
      { agentId: 'claude', name: 'foo', side: 'agent', relPath: 'mod.txt' },
      trusted,
    )) as { text: string | null };
    expect(c.text).toBe('central');
    expect(a.text).toBe('agent');
  });
});

describe('skills IPC — import', () => {
  it('returns {imported:null} without touching the store when the picker is cancelled', async () => {
    pickImportDir.mockResolvedValueOnce(null);
    const result = (await reg.invoke(IPC_CHANNELS.skillsImport, undefined, trusted)) as {
      imported: string | null;
    };
    expect(result.imported).toBeNull();
  });

  it('imports the picked directory into central', async () => {
    const src = path.join(root, 'external', 'picked');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, SKILL_MARKER), '---\nname: picked\n---\n');
    pickImportDir.mockResolvedValueOnce(src);
    const result = (await reg.invoke(IPC_CHANNELS.skillsImport, undefined, trusted)) as {
      imported: string | null;
    };
    expect(result.imported).toBe('picked');
    expect(fs.existsSync(path.join(central, 'picked', SKILL_MARKER))).toBe(true);
  });
});

describe('skills IPC — reveal', () => {
  it('opens the central library dir the store resolved', async () => {
    await reg.invoke(IPC_CHANNELS.skillsReveal, { scope: 'central' }, trusted);
    expect(openPath).toHaveBeenCalledWith(path.resolve(central));
  });

  it('opens a specific agent skill dir', async () => {
    await reg.invoke(IPC_CHANNELS.skillsReveal, { scope: 'agent', agentId: 'claude', name: 'foo' }, trusted);
    expect(openPath).toHaveBeenCalledWith(path.resolve(agentSkillsDir('claude'), 'foo'));
  });

  it('rejects a bad scope and never opens anything', async () => {
    expect(await codeOfInvoke(IPC_CHANNELS.skillsReveal, { scope: 'elsewhere' }, trusted)).toBe(
      'INVALID_PARAMS',
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it('rejects a traversal name in a reveal ref before opening', async () => {
    expect(
      await codeOfInvoke(IPC_CHANNELS.skillsReveal, { scope: 'central', name: '../../etc' }, trusted),
    ).toBe('INVALID_PARAMS');
    expect(openPath).not.toHaveBeenCalled();
  });
});
