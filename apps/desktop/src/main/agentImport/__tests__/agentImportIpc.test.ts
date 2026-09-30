import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryRegistry } from '../../ipc/registry';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { registerAgentImportIpc } from '../agentImportIpc';
import { createProviderManager } from '../../providers/providerManager';
import { createProviderStore } from '../../providers/providerStore';
import { AGENT_IMPORT_AGENT_IDS } from '../../../shared/agentImport';
import type { ProviderManager } from '../../providers/providerManager';
import type { TranslationProxy } from '../../proxy/translationProxy';
import type { SecretStore } from '../../secrets/secretStore';

describe('agent import IPC', () => {
  it('returns scan candidates from the manager', async () => {
    const candidates = [
      {
        agentId: 'codex' as const,
        agentName: 'Codex',
        available: false,
        accountLabel: null,
        reason: 'not_signed_in' as const,
      },
    ];
    const manager = {
      scanAgentImports: vi.fn(() => candidates),
      addAgentImportProvider: vi.fn(),
    } as unknown as ProviderManager;
    const reg = createInMemoryRegistry();
    registerAgentImportIpc(reg, manager);
    const meta = { assertTrustedSender: () => {} };
    const out = await reg.invoke(IPC_CHANNELS.providersAgentImportScan, undefined, meta);
    expect(out).toEqual({ candidates });
  });

  describe('with a real provider manager', () => {
    let prevHome: string | undefined;
    let sandboxHome: string;

    beforeEach(() => {
      prevHome = process.env.AIOPT_AGENT_HOME;
      sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-agent-ipc-'));
      process.env.AIOPT_AGENT_HOME = sandboxHome;
    });

    afterEach(() => {
      if (prevHome === undefined) delete process.env.AIOPT_AGENT_HOME;
      else process.env.AIOPT_AGENT_HOME = prevHome;
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    });

    it('scan returns codex and claude rows', async () => {
      const secrets: SecretStore = {
        isAvailable: () => true,
        set: () => {},
        get: () => null,
        has: () => false,
        delete: () => {},
      };
      const proxy: TranslationProxy = {
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        getPort: () => 4567,
        rebindPort: () => Promise.resolve(4568),
        registerRoute: () => ({ baseUrl: 'http://127.0.0.1:4567/tok', token: 'tok' }),
        unregisterRoute: () => {},
        isRouted: () => false,
        endpointFor: () => null,
      };
      const manager = createProviderManager(
        createProviderStore({ load: () => ({}), save: () => {} }),
        secrets,
        new Map(),
        () => {},
        () => proxy,
        () => false,
      );
      const reg = createInMemoryRegistry();
      registerAgentImportIpc(reg, manager);
      const out = (await reg.invoke(IPC_CHANNELS.providersAgentImportScan, undefined, {
        assertTrustedSender: () => {},
      })) as { candidates: { agentId: string }[] };
      expect(out.candidates.map((c) => c.agentId)).toEqual([...AGENT_IMPORT_AGENT_IDS]);
    });
  });
});
